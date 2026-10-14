#!/usr/bin/env node
// plantrail v0 — codebase-grounded daemon.
// Spine: fs watcher on the repo + selected Superpowers plan. No hooks required
// (hooks become an optional fidelity adapter later).
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ---------- CLI ----------
const argv = process.argv.slice(2)
let cmd = null
let repo = process.cwd()
let port = 5330
const spawningPaths = new Set()
let openBrowser = process.stdout.isTTY ? true : false
let noOpen = false
let removeFlag = false
let printFlag = false
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === 'init') cmd = 'init'
  else if (a === 'hook') cmd = 'hook'
  else if (a === '--port') port = parseInt(argv[++i], 10)
  else if (a === '--open') openBrowser = true
  else if (a === '--no-open') { noOpen = true; openBrowser = false }
  else if (a === 'up') cmd = 'up'
  else if (a === 'autostart') cmd = 'autostart'
  else if (a === '--remove') removeFlag = true
  else if (a === '--print') printFlag = true
  else repo = path.resolve(a)
}
// Superpowers writes plans under <session dir>/docs/superpowers/plans and each
// plan's ledger under <git root>/.superpowers/sdd/<plan>/, so where to look depends
// on where the agent worked: the start dir, its sub-repos (when it is not a repo
// itself) and every git worktree of those repos.
const PLAN_SUBDIRS = ['docs/superpowers/plans', '.superpowers/plans']
const LEDGER_SUBDIR = '.superpowers/sdd'
const isGitDir = dir => fs.existsSync(path.join(dir, '.git'))
function worktreesOf(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9)).filter(p => fs.existsSync(p))
  } catch { return [] }
}
// last known execution state per plan — see trackExecution()
const planRuns = {}
let rootsCache = { at: 0, roots: [repo] }
function searchRoots() {
  if (Date.now() - rootsCache.at < 10000) return rootsCache.roots
  let repos = [repo]
  if (!isGitDir(repo)) {
    try {
      repos = fs.readdirSync(repo, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && isGitDir(path.join(repo, e.name)))
        .map(e => path.join(repo, e.name))
    } catch { repos = [] }
  }
  const roots = new Set([repo])
  for (const r of repos) for (const w of worktreesOf(r)) roots.add(w)
  rootsCache = { at: Date.now(), roots: [...roots] }
  return rootsCache.roots
}
const rootOf = file => searchRoots().filter(r => file.startsWith(r + path.sep)).sort((a, b) => b.length - a.length)[0] || repo
function listDir(dir, keep) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(keep).map(e => path.join(dir, e.name)) } catch { return [] }
}
function availablePlans() {
  return searchRoots()
    .flatMap(root => PLAN_SUBDIRS.flatMap(sub => listDir(path.join(root, sub), e => e.isFile() && e.name.endsWith('.md'))))
    .sort()
}
// every ledger file with the root it lives in — a ledger's plan path is relative to that root
function ledgerFiles() {
  return searchRoots().flatMap(root => {
    const dir = path.join(root, LEDGER_SUBDIR)
    const files = listDir(dir, e => e.isDirectory()).map(d => path.join(d, 'progress.md'))
    if (fs.existsSync(path.join(dir, 'progress.md'))) files.push(path.join(dir, 'progress.md'))
    return files.map(file => ({ file, root }))
  })
}
const trackedDirs = () => searchRoots().flatMap(root => [...PLAN_SUBDIRS, LEDGER_SUBDIR].map(sub => path.join(root, sub)))
let planPath = cmd ? '' : availablePlans()[0] || path.join(repo, '__no_plan_selected__.md')
if (cmd === 'init') { installHooks(); process.exit(0) }
if (cmd === 'up') { await upAll(); process.exit(0) }
if (cmd === 'autostart') { autostart(); process.exit(0) }
if (cmd === 'hook') { await relayHook(); process.exit(0) }

// reads a claude code hook payload on stdin and fans it out to local daemons;
// each daemon keeps only events whose cwd lives inside its repo. Never blocks
// the agent: 400ms cap, failures are silent.
async function relayHook() {
  let raw = ''
  try { for await (const c of process.stdin) raw += c } catch {}
  if (!raw) return
  const ports = process.env.AGENTTRAIL_PORT ? [parseInt(process.env.AGENTTRAIL_PORT, 10)] : Array.from({ length: 15 }, (_, i) => 5330 + i)
  await Promise.allSettled(ports.map(p => fetch(`http://127.0.0.1:${p}/hook`, {
    method: 'POST', body: raw, signal: AbortSignal.timeout(400),
  }).catch(() => {})))
  // SessionStart: ask daemons for a staleness nudge — stdout lands in the agent's context
  try {
    const ev = JSON.parse(raw)
    if (ev.hook_event_name === 'SessionStart' && ev.cwd) {
      for (const p of ports) {
        try {
          const r = await fetch(`http://127.0.0.1:${p}/nudge?cwd=${encodeURIComponent(ev.cwd)}`, { signal: AbortSignal.timeout(400) })
          const t = (await r.text()).trim()
          if (t) { console.log(t); break }
        } catch {}
      }
    }
  } catch {}
}

// ---------- plan parsing ----------
const NODE_RE = /^##\s+(.+?)\s*\{#([a-z0-9][a-z0-9-]*)\}\s*$/i
const TASK_RE = /^\s*[-*]\s+\[( |x|~|!)\]\s+(.+?)\s*\{#([a-z0-9][a-z0-9-]*)\}\s*$/i
const NEEDS_RE = /^needs:\s*\[([^\]]*)\]\s*$/i
const LINKS_RE = /^links:\s*\[([^\]]*)\]\s*$/i
const FILES_RE = /^files:\s*\[([^\]]*)\]\s*$/i
const TECH_RE = /^\s*tech:\s*(.+?)\s*$/i
const BY_RE = /^\s*by:\s*(.+?)\s*$/i
const FROM_RE = /^\s*(?:from|horizon):\s*(agent|roadmap|now|backlog)\s*$/i
const KIND_RE = /^\s*kind:\s*([a-z][a-z-]*)\s*$/i
const URL_RE = /^\s*url:\s*(\S+)\s*$/i
const DECISIONS_RE = /^##\s+decisions\s*$/i
const idList = s => s.split(',').map(x => x.trim()).filter(Boolean)

function parsePlan(text) {
  const nodes = [] // ordered
  const decisions = []
  let title = ''
  let curComponent = null
  let lastNode = null // tech: lines attach to the most recent component or task
  let inDecisions = false
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    if (!title && /^#\s+/.test(line)) { title = line.replace(/^#\s+/, ''); continue }
    if (DECISIONS_RE.test(line)) { inDecisions = true; curComponent = null; lastNode = null; continue }
    let m
    if ((m = line.match(NODE_RE))) {
      inDecisions = false
      curComponent = { id: m[2], title: m[1], level: 'component', parent: null, needs: [], links: [], files: [], tech: '', by: '', kind: '', url: '', status: 'pending' }
      lastNode = curComponent
      nodes.push(curComponent)
      continue
    }
    if (inDecisions) {
      if (/^\s*[-*]\s+/.test(line)) decisions.push(line.replace(/^\s*[-*]\s+/, ''))
      continue
    }
    if ((m = line.match(TASK_RE))) {
      const status = m[1] === 'x' ? 'done' : m[1] === '~' ? 'active' : m[1] === '!' ? 'blocked' : 'pending'
      lastNode = { id: m[3], title: m[2], level: 'task', parent: curComponent ? curComponent.id : null, needs: [], links: [], tech: '', by: '', src: '', status }
      nodes.push(lastNode)
      continue
    }
    if ((m = line.match(TECH_RE))) { if (lastNode) lastNode.tech = m[1]; continue }
    if ((m = line.match(KIND_RE))) { if (curComponent) curComponent.kind = m[1].toLowerCase(); continue }
    if ((m = line.match(URL_RE))) { if (curComponent) curComponent.url = m[1]; continue }
    if ((m = line.match(BY_RE))) { if (lastNode) lastNode.by = m[1]; continue }
    if ((m = line.match(FROM_RE))) { if (lastNode) { const v = m[1].toLowerCase(); lastNode.src = v === 'now' ? 'agent' : v === 'backlog' ? 'roadmap' : v } continue }
    if ((m = line.match(NEEDS_RE))) { if (curComponent) curComponent.needs = idList(m[1]); continue }
    if ((m = line.match(LINKS_RE))) { if (curComponent) curComponent.links = idList(m[1]); continue }
    if ((m = line.match(FILES_RE))) { if (curComponent) curComponent.files = idList(m[1]); continue }
  }
  // derive component status from its tasks — blocked wins (it demands attention)
  for (const c of nodes.filter(n => n.level === 'component')) {
    const kids = nodes.filter(n => n.parent === c.id)
    if (kids.some(k => k.status === 'blocked')) c.status = 'blocked'
    else if (kids.some(k => k.status === 'active')) c.status = 'active'
    else if (kids.length && kids.every(k => k.status === 'done')) c.status = 'done'
  }
  return { nodes, decisions, title }
}

// Superpowers keeps durable plans separate from each plan's SDD ledger. The
// ledger's identity line binds completion records to the selected plan.
function ledgerFor(planFile) {
  for (const { file, root } of ledgerFiles()) {
    const ledger = safeRead(file)
    const identity = ledger.match(/^# SDD ledger — plan:\s*(.+)$/m)?.[1]?.trim()
    if (identity && path.resolve(root, identity) === planFile) return { ledger, dir: path.dirname(file), root }
  }
  return null
}
const completedIn = ledger => new Set([...ledger.matchAll(/^Task\s+(\d+):\s+complete\b/gim)].map(m => Number(m[1])))
// with the ledger gone, fall back to what it last said (everything, for an executed plan)
function completedSuperpowersTasks(planFile) {
  const found = ledgerFor(planFile)
  return found !== null ? completedIn(found.ledger) : new Set(planRuns[planFile]?.completed || [])
}

function parseSuperpowersPlan(text, planFile) {
  const nodes = []
  const decisions = []
  const title = text.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(planFile, '.md')
  const completed = completedSuperpowersTasks(planFile)
  const taskHead = /^#{2,4}\s+Task\s+(\d+)\s*[:—-]\s*(.+?)\s*$/i
  const lines = text.split('\n')
  let component = null
  let step = 0
  let taskBody = []
  const finishTask = () => {
    if (!component) return
    const body = taskBody.join('\n')
    const files = new Set()
    for (const line of taskBody) {
      const explicit = line.match(/^\s*Files?:\s*(.+)$/i)?.[1]
      if (explicit) for (const value of explicit.split(/[,;]/)) {
        const file = value.trim().replace(/^[\s`[\]]+|[\s`[\]]+$/g, '')
        if (file && /[/.]/.test(file)) files.add(file.replace(/^\.\//, ''))
      }
      for (const match of line.matchAll(/`((?:\.\/)?(?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9._-]+)`/g)) files.add(match[1].replace(/^\.\//, ''))
    }
    component.files = [...files]
    if (step === 0) {
      nodes.push({ id: `${component.id}-step-1`, title: component.title, level: 'task', parent: component.id, synthetic: true, needs: [], links: [], tech: '', by: '', src: '', status: completed.has(component.taskNumber) ? 'done' : 'pending' })
    }
    component = null
    taskBody = []
  }
  for (const line of lines) {
    const match = line.match(taskHead)
    if (match) {
      finishTask()
      const taskNumber = Number(match[1])
      const id = `task-${taskNumber}`
      component = { id, taskNumber, title: match[2], level: 'component', parent: null, needs: [], links: [], files: [], tech: '', by: '', kind: '', url: '', status: completed.has(taskNumber) ? 'done' : 'pending' }
      nodes.push(component)
      step = 0
      taskBody = []
      continue
    }
    if (!component) {
      if (/^##\s+decisions\s*$/i.test(line)) continue
      continue
    }
    taskBody.push(line)
    const box = line.match(/^\s*[-*]\s+\[([ x~!])\]\s+(.+?)\s*$/i)
    if (!box) continue
    step++
    const status = completed.has(component.taskNumber) ? 'done' : box[1].toLowerCase() === 'x' ? 'done' : box[1] === '~' ? 'active' : box[1] === '!' ? 'blocked' : 'pending'
    nodes.push({ id: `${component.id}-step-${step}`, title: box[2], level: 'task', parent: component.id, needs: [], links: [], tech: '', by: '', src: '', status })
  }
  finishTask()
  for (const component of nodes.filter(n => n.level === 'component')) {
    const steps = nodes.filter(n => n.parent === component.id)
    if (steps.some(step => step.status === 'blocked')) component.status = 'blocked'
    else if (steps.some(step => step.status === 'active')) component.status = 'active'
    else if (steps.length && steps.every(step => step.status === 'done')) component.status = 'done'
  }
  return { nodes, decisions, title, superpowers: true }
}

function parseTrackedPlan(text, filePath) {
  return /^(?:#{2,4})\s+Task\s+\d+\s*[:—-]/im.test(text) ? parseSuperpowersPlan(text, filePath) : parsePlan(text)
}

// ---------- live state ----------
const session = { id: Math.random().toString(36).slice(2, 10), project: path.basename(repo), startedAt: new Date().toISOString() }
let planText = safeRead(planPath)
let parsed = parseTrackedPlan(planText, planPath)
let activity = null // { file, at } — most recent non-plan repo write
let recentActivity = [] // last N writes, newest first — feeds the live-view drill-down
let planMtime = statMtime(planPath)
const clients = new Set()

// ---------- observed activity per component (files: globs) ----------
// Declared status ([~]/[x]) says what the agent claims; this says what the
// filesystem shows. A component whose files are being written is live no
// matter what its checkbox says — that is how "revising done work" stays visible.
const compTouched = {} // component id -> last matching write ts
const compRecent = {} // component id -> [{file, at}] newest first — feeds capsule work lines
const fileHeat = {} // file -> last touch ts, capped
function heatFile(file, at) {
  fileHeat[file] = at
  const keys = Object.keys(fileHeat)
  if (keys.length > 600) { keys.sort((a, b) => fileHeat[a] - fileHeat[b]); for (const k of keys.slice(0, 100)) delete fileHeat[k] }
}
function globToRe(g) {
  if (!/[*?]/.test(g)) return new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&') + '(/|$)')
  const esc = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')
  return new RegExp('^' + esc + '$')
}
let compMatchers = []
function rebuildMatchers() {
  compMatchers = parsed.nodes.filter(n => n.level === 'component' && n.files.length)
    .map(c => ({ id: c.id, res: c.files.map(globToRe) }))
}
function touchComponents(file, at) {
  for (const m of compMatchers) if (m.res.some(re => re.test(file))) {
    compTouched[m.id] = at
    const arr = compRecent[m.id] || (compRecent[m.id] = [])
    if (arr[0] && arr[0].file === file) arr[0] = { file, at, n: (arr[0].n || 1) + 1 }
    else arr.unshift({ file, at, n: 1 })
    if (arr.length > 6) arr.length = 6
  }
}

// ---------- live runs (claude code hooks adapter) ----------
// The run is the foreground: what the agent is doing right now — current
// todo, streaming tool line, recent calls — pinned to a component on the map.
const runs = {} // session id -> run
const handoffs = [] // {c, from, to, at} — one session picks up where another stopped
function runFor(id, cwd) {
  return runs[id] || (runs[id] = { id, agent: 'claude', cwd, startedAt: Date.now(), lastEventAt: Date.now(), todos: [], currentTool: null, recentTools: [], componentId: null, ended: false })
}
function toolDetail(input = {}) {
  const p = input.file_path || input.notebook_path
  const d = input.command || (p ? (relToRepo(p) ?? p) : '') || input.description || input.pattern || input.url || input.query || input.prompt || ''
  return String(d).replace(/\s+/g, ' ').slice(0, 90)
}
function relToRepo(p) {
  if (!p) return null
  const r = path.resolve(String(p))
  return r === repo ? '' : r.startsWith(repo + path.sep) ? r.slice(repo.length + 1) : null
}
function handleHookEvent(ev) {
  const cwd = ev.cwd || ''
  if (!(cwd === repo || cwd.startsWith(repo + path.sep))) return false
  const run = runFor(ev.session_id || 'session', cwd)
  if (ev.agent) run.agent = String(ev.agent).slice(0, 24).toLowerCase()
  run.lastEventAt = Date.now()
  stateDirty = true
  const kind = ev.hook_event_name
  if (kind === 'SessionStart') run.ended = false
  else if (kind === 'Stop' || kind === 'SessionEnd') { run.ended = true; run.currentTool = null }
  else if (kind === 'PreToolUse') {
    run.ended = false
    run.currentTool = { name: ev.tool_name, detail: toolDetail(ev.tool_input), at: Date.now() }
    if (ev.tool_name === 'Task' && ev.tool_input) {
      const name = String(ev.tool_input.description || ev.tool_input.subagent_type || 'sub-agent').slice(0, 60)
      ;(run.subagents = run.subagents || []).push({ name, startedAt: Date.now(), ended: false })
      if (run.subagents.length > 12) run.subagents.shift()
    }
  } else if (kind === 'SubagentStop') {
    const sa = (run.subagents || []).find(x => !x.ended)
    if (sa) { sa.ended = true; sa.endedAt = Date.now() }
  } else if (kind === 'PostToolUse') {
    run.ended = false
    const started = run.currentTool && run.currentTool.name === ev.tool_name ? run.currentTool.at : Date.now()
    run.recentTools.unshift({ name: ev.tool_name, detail: toolDetail(ev.tool_input), at: Date.now(), ms: Date.now() - started })
    if (run.recentTools.length > 8) run.recentTools.length = 8
    run.currentTool = null
    if (ev.tool_name === 'TodoWrite' && ev.tool_input && Array.isArray(ev.tool_input.todos)) {
      run.todos = ev.tool_input.todos.map(t => ({ content: t.content, status: t.status }))
    }
    const rel = relToRepo(ev.tool_input && (ev.tool_input.file_path || ev.tool_input.notebook_path))
    if (rel) {
      heatFile(rel, Date.now())
      touchComponents(rel, Date.now())
      activity = { file: rel, at: Date.now() }
      for (const m of compMatchers) if (m.res.some(re => re.test(rel))) {
        if (run.componentId !== m.id) {
          (run.path = run.path || []).push({ c: m.id, at: Date.now() })
          const prev = Object.values(runs).find(r2 => r2.id !== run.id && r2.ended && r2.componentId === m.id && Date.now() - r2.lastEventAt < 10 * 60e3)
          if (prev) { handoffs.push({ c: m.id, from: prev.agent, to: run.agent, at: Date.now() }); if (handoffs.length > 10) handoffs.shift() }
        }
        run.componentId = m.id
        if (run.path && run.path.length > 20) run.path.shift()
      }
    }
  } else return false
  return true
}
let cycles = [] // saved history: [{start,end,sessions:[{agent,componentId,tools}]}]
function archiveRun(r) {
  const start = r.startedAt, end = r.lastEventAt
  let c = cycles.find(c => start <= c.end + 30 * 60e3 && end >= c.start - 30 * 60e3)
  if (!c) { c = { start, end, sessions: [] }; cycles.push(c) }
  c.start = Math.min(c.start, start); c.end = Math.max(c.end, end)
  c.sessions.push({ agent: r.agent, componentId: r.componentId, tools: (r.recentTools || []).length, todosDone: (r.todos || []).filter(t => t.status === 'completed').length })
  cycles.sort((a, b) => b.start - a.start)
  if (cycles.length > 30) cycles.length = 30
  stateDirty = true
}
function liveRuns() {
  const now = Date.now()
  for (const [id, r] of Object.entries(runs)) {
    if (!r.ended && now - r.lastEventAt > 15 * 60e3) { r.ended = true; r.currentTool = null } // missed Stop
    if (now - r.lastEventAt > 2 * 3600e3) { archiveRun(r); delete runs[id] } // 2h trail → saved cycle record
  }
  return Object.values(runs).sort((a, b) => a.startedAt - b.startedAt)
}

// ---------- observed-state persistence (survives daemon restarts) ----------
// Lives under ~/.plantrail keyed by repo path — never touches the repo itself.
const repoId = crypto.createHash('sha1').update(repo).digest('hex').slice(0, 12)
const stateFile = path.join(os.homedir(), '.plantrail', repoId + '.json')
// Superpowers deletes a plan's sdd workspace when the plan is done: a copy is kept in
// ~/.plantrail/<id>/sdd/<workspace>, refreshed on every change, as the record of what ran.
const archiveRoot = path.join(os.homedir(), '.plantrail', repoId, 'sdd')
const ARCHIVE_MAX_FILE = 1024 * 1024
function archiveSdd(dir, root) {
  const name = path.basename(dir) + (root === repo ? '' : '@' + path.basename(root))
  try {
    fs.cpSync(dir, path.join(archiveRoot, name), { recursive: true, force: true, filter: src => { try { return fs.statSync(src).isDirectory() || fs.statSync(src).size <= ARCHIVE_MAX_FILE } catch { return false } } })
    return name
  } catch { return null }
}
let stateDirty = false
// Superpowers deletes a plan's sdd once its final review is clean, so what the ledger last
// said is remembered here: running (sdd seen) → executed (it vanished). Tasks are counted
// as the ledger reports them: a task skipped by hand stays "not done" in N/M. Records of
// plans that no longer exist are dropped with their archive.
const taskNumbers = text => new Set([...text.matchAll(/^#{2,4}\s+Task\s+(\d+)\s*[:—-]/gim)].map(m => Number(m[1])))
// where the run is: setup before the first brief, the task being worked (and its fix round), the whole-branch review once
// its review package exists, or the closing "Final" ledger lines
function sddPhase(dir, ledger, planTasks, completed) {
  // before the first task brief is written the run is still reading the plan and ruling on conflicts
  const started = /^Task\s+\d+:/im.test(ledger) || (() => { try { return fs.readdirSync(dir).some(f => /^task-\d+-brief\.md$/.test(f)) } catch { return false } })()
  if (!started) return 'setup'
  const skipped = new Set([...ledger.matchAll(/^.*\bTask\s+(\d+)\b.*\bskipped\b/gim)].map(m => Number(m[1])))
  const highest = completed.length ? completed[completed.length - 1] : -1
  const next = [...planTasks].sort((a, b) => a - b).find(n => n > highest && !skipped.has(n))
  if (next !== undefined) {
    const fix = [...ledger.matchAll(new RegExp(`^Task\\s+${next}:\\s+fix round (\\d+)/(\\d+)`, 'gim'))].pop()
    return fix ? `Task ${next} · fix round ${fix[1]}/${fix[2]}` : `Task ${next}`
  }
  if (/^Final\b/im.test(ledger)) return 'closing'
  const ranges = n => ledger.match(new RegExp(`^Task\\s+${n}:\\s+complete \\(commits (\\w+)\\.\\.(\\w+)`, 'im'))
  const first = ranges(completed[0]), last = ranges(completed[completed.length - 1])
  const whole = first && last && `review-${first[1]}..${last[2]}.diff`
  return whole && fs.existsSync(path.join(dir, whole)) ? 'final review' : 'tasks done'
}
const newestMtime = dir => { try { return Math.max(...fs.readdirSync(dir).map(f => fs.statSync(path.join(dir, f)).mtimeMs)) } catch { return 0 } }
function trackExecution() {
  for (const file of availablePlans()) {
    const found = ledgerFor(file)
    const rec = planRuns[file]
    if (found !== null) {
      const planTasks = taskNumbers(safeRead(file))
      const completed = [...completedIn(found.ledger)].sort((a, b) => a - b)
      const lines = found.ledger.split('\n').map(l => l.trim()).filter(Boolean)
      const next = {
        state: 'running', total: planTasks.size, done: completed.length, completed,
        phase: sddPhase(found.dir, found.ledger, planTasks, completed), lastLine: lines[lines.length - 1] || '', activeAt: Math.round(newestMtime(found.dir)),
        archive: archiveSdd(found.dir, found.root) ?? rec?.archive,
      }
      if (JSON.stringify(next) !== JSON.stringify(rec)) { planRuns[file] = next; stateDirty = true }
    } else if (rec?.state === 'running') {
      planRuns[file] = { ...rec, state: 'executed', phase: undefined }
      stateDirty = true
    }
  }
  for (const file of Object.keys(planRuns)) {
    if (fs.existsSync(file)) continue
    const archive = planRuns[file].archive
    if (archive && !archive.includes('/')) try { fs.rmSync(path.join(archiveRoot, archive), { recursive: true, force: true }) } catch {}
    delete planRuns[file]
    stateDirty = true
  }
}
function loadState() {
  try {
    const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    activity = st.activity || null
    recentActivity = st.recentActivity || []
    Object.assign(runs, st.runs || {})
    cycles = st.cycles || []
    Object.assign(compTouched, st.compTouched || {})
    Object.assign(compRecent, st.compRecent || {})
    Object.assign(fileHeat, st.fileHeat || {})
    Object.assign(planRuns, st.planRuns || {})
  } catch {}
}
function saveState() {
  if (!stateDirty) return
  stateDirty = false
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true })
    fs.writeFileSync(stateFile, JSON.stringify({ repoPath: repo, port, activity, recentActivity, compTouched, compRecent, runs, fileHeat, cycles, planRuns }))
  } catch {}
}
loadState()
trackExecution()
parsed = parseTrackedPlan(planText, planPath) // state is loaded now: re-read completion of plans whose ledger is gone
stateDirty = true // boot save: registers this repo for `plantrail up`
setInterval(saveState, 15000).unref()
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stateDirty = true; saveState(); process.exit(0) })

// ---------- repo tree (vs-code-style explorer, folders first) ----------
const IGNORE = /(^|\/)(\.git|node_modules|\.plantrail|dist|build|\.next|__pycache__|\.venv|\.build|\.pytest_cache|\.ruff_cache|\.cache|\.DS_Store)(\/|$)/
// editor/tool atomic-write droppings — not real activity targets
const TMP_FILE = /(\.tmp(\.|$)|~$|\.swp$|\.swx$|(^|\/)\.#|(^|\/)#.+#$|\.DS_Store$)/

function buildTree(rootDir, budgetN = 4000, perDir = 250) {
  treeTruncated = false
  const root = []
  const queue = [{ dir: rootDir, rel: '', depth: 0, out: root }]
  let budget = budgetN
  while (queue.length) {
    const { dir, rel, depth, out } = queue.shift()
    if (depth > 8) continue
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    let taken = 0
    for (const e of entries) {
      const r = rel ? rel + '/' + e.name : e.name
      if (IGNORE.test(r) || TMP_FILE.test(r)) continue
      if (taken >= perDir || budget <= 0) { treeTruncated = true; break }
      taken++; budget--
      if (e.isDirectory()) {
        const node = { name: e.name, path: r, dir: true, children: [] }
        out.push(node)
        queue.push({ dir: path.join(dir, e.name), rel: r, depth: depth + 1, out: node.children })
      } else if (e.isFile()) out.push({ name: e.name, path: r, dir: false })
    }
    out.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name))
  }
  return root
}
let treeTruncated = false
let tree = buildTree(repo)
let treeDirty = false
let lastTreeSent = Date.now()
rebuildMatchers()

function safeRead(p) { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }
function statMtime(p) { try { return fs.statSync(p).mtimeMs } catch { return null } }

function compFilesFor(id) {
  const m = compMatchers.find(x => x.id === id)
  if (!m) return []
  const out = []
  const walk = t => { for (const n of t) { if (n.dir) walk(n.children || []); else if (m.res.some(re => re.test(n.path))) out.push(n.path) } }
  walk(tree)
  out.sort((a, b) => (fileHeat[b] || 0) - (fileHeat[a] || 0) || a.length - b.length || a.localeCompare(b))
  return out.slice(0, 24)
}
function hotFiles() {
  const now = Date.now(), out = {}
  for (const [f, at] of Object.entries(fileHeat)) if (now - at < 60000) out[f] = at
  return out
}
function lintPlan() {
  const out = []
  const comps = parsed.nodes.filter(n => n.level === 'component')
  const tasks = parsed.nodes.filter(n => n.level === 'task')
  if (!planText.length || (comps.length === 1 && tasks.length <= 1)) return out
  const ids = new Set()
  for (const n of parsed.nodes) { if (ids.has(n.id)) out.push(`duplicate id {#${n.id}}`); ids.add(n.id) }
  const compIds = new Set(comps.map(c => c.id))
  for (const c of comps) {
    for (const e of [...c.needs, ...c.links]) if (!compIds.has(e)) out.push(`${c.id}: edge to unknown component "${e}"`)
    if (!parsed.superpowers && !c.files.length) out.push(`${c.id}: no files: globs — the live layer can't pin work to it`)
  }
  if (!parsed.superpowers) for (const t of tasks) if (t.status === 'done' && !t.tech) out.push(`[x] "${t.title}" cites no evidence (tech: line)`)
  if (comps.length > 9) out.push(`${comps.length} components — over the 5–9 governor, consider merging`)
  return out.slice(0, 12)
}
let hooksInstalledCache = { at: 0, val: false }
function hooksInstalled() {
  if (Date.now() - hooksInstalledCache.at < 30000) return hooksInstalledCache.val
  const val = safeRead(path.join(repo, '.claude', 'settings.local.json')).includes('plantrail')
  hooksInstalledCache = { at: Date.now(), val }
  return val
}
function planStaleness() {
  // code moving while the plan sits untouched — the drift that makes boards look dead
  if (!activity || !planMtime) return { stale: false }
  const gap = activity.at - planMtime
  const fresh = Date.now() - activity.at < 15 * 60e3
  return gap > 20 * 60e3 && fresh ? { stale: true, minutes: Math.round(gap / 60e3) } : { stale: false }
}
const execLabel = r => !r ? '' : r.state === 'running' ? ` · running ${r.done}/${r.total} · ${r.phase}` : ` · ${r.state} ${r.done}/${r.total}`
function model() {
  if (treeDirty) { tree = buildTree(repo); treeDirty = false }
  return {
    boards, port,
    runs: liveRuns(),
    session, plan: parsed.nodes.map(n => n.level === 'component' ? { ...n, touchedAt: compTouched[n.id] || null, recent: compRecent[n.id] || [], filesList: compFilesFor(n.id) } : n), tree,
    planTitle: parsed.title, planFile: path.relative(repo, planPath), planDir: path.relative(repo, path.dirname(planPath)), superpowers: !!parsed.superpowers,
    plans: availablePlans().map(file => ({ path: path.relative(repo, file), title: (searchRoots().length > 1 ? path.basename(rootOf(file)) + ' · ' : '') + path.basename(file, '.md') + execLabel(planRuns[file]), exec: planRuns[file]?.state || null })),
    hasPlan: planText.length > 0, treeTruncated,
    activity, recentActivity, planMtime, handoffs, hotFiles: hotFiles(), cycles,
    planExec: planRuns[planPath] || null, planStale: planStaleness(), lints: lintPlan(), hooksInstalled: hooksInstalled(),
    now: Date.now(),
  }
}

function send(obj) {
  const data = `data: ${JSON.stringify(obj)}\n\n`
  for (const res of clients) res.write(data)
}
function broadcast() { send(model()) }
// activity ticks carry only what moved — the 600KB tree stays home
function broadcastTick() {
  send({ partial: true, runs: liveRuns(), activity, recentActivity, touched: { ...compTouched }, compRecent, handoffs, hotFiles: hotFiles(), now: Date.now() })
}

// ---------- watcher ----------
let planDebounce = null
function refreshTrackedPlan() {
  clearTimeout(planDebounce)
  planDebounce = setTimeout(() => {
    trackExecution()
    const plans = availablePlans()
    if (!plans.includes(planPath)) planPath = plans[0] || path.join(repo, '__no_plan_selected__.md')
    planText = safeRead(planPath)
    parsed = parseTrackedPlan(planText, planPath)
    rebuildMatchers()
    planMtime = statMtime(planPath)
    broadcast()
  }, 150)
}
function isPlanOrLedgerPath(file) {
  const absolute = path.resolve(repo, file)
  return trackedDirs().some(d => absolute === d || absolute.startsWith(d + path.sep))
}
try {
  fs.watch(repo, { recursive: true }, (_ev, filename) => {
    if (!filename) return
    const f = filename.toString().split(path.sep).join('/')
    if (isPlanOrLedgerPath(f)) { refreshTrackedPlan(); return }
    if (IGNORE.test(f) || TMP_FILE.test(f)) return
    // plain repo churn → liveness signal
    treeDirty = true
    stateDirty = true
    activity = { file: f, at: Date.now() }
    heatFile(f, activity.at)
    touchComponents(f, activity.at)
    if (!recentActivity.length || recentActivity[0].file !== f) recentActivity.unshift(activity)
    else recentActivity[0] = activity
    recentActivity = recentActivity.slice(0, 12)
    throttleBroadcast()
  })
} catch (e) {
  // recursive watch is unsupported on some platforms (older linux) — degrade:
  // Plan-file and top-level changes still tracked, deep activity limited.
  try {
    fs.watch(repo, (_ev, filename) => {
      if (!filename) return
      const f = filename.toString()
      if (isPlanOrLedgerPath(f)) refreshTrackedPlan()
    })
    console.error('note: recursive file watching unavailable here — plan updates still live, deep file activity limited')
  } catch (e2) {
    console.error('watcher failed:', e2.message)
  }
}
const repoPath = path.resolve(repo)
const isInsideRepo = target => {
  const relative = path.relative(repoPath, target)
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
}
// plan/ledger folders outside the start dir (worktrees elsewhere) need their own watcher;
// a slow rescan also picks up new repos, worktrees and folders created after startup
const watchedDirs = new Set()
function syncWatchers() {
  for (const d of trackedDirs()) {
    if (watchedDirs.has(d) || isInsideRepo(d) || !fs.existsSync(d)) continue
    try {
      const w = fs.watch(d, { recursive: true }, refreshTrackedPlan)
      w.on('error', () => { w.close(); watchedDirs.delete(d) })
      watchedDirs.add(d)
    } catch {}
  }
}
let trackedSignature = ''
const signature = () => availablePlans().join('|') + '#' + ledgerFiles().map(l => l.file).join('|')
function rescanTracked() {
  rootsCache.at = 0
  syncWatchers()
  const next = signature()
  if (next !== trackedSignature) { trackedSignature = next; refreshTrackedPlan() }
}
trackedSignature = signature()
syncWatchers()
setInterval(rescanTracked, 10000).unref()
let lastActivityPush = 0
function throttleBroadcast() {
  const now = Date.now()
  if (now - lastActivityPush <= 1000) return
  lastActivityPush = now
  if (treeDirty && now - lastTreeSent > 10000) { lastTreeSent = now; broadcast() } // tree refresh, at most every 10s
  else broadcastTick()
}

// ---------- sibling boards (multi-repo: one daemon per repo, boards link to each other) ----------
let boards = [{ port, project: path.basename(repo), self: true }]
async function discoverBoards() {
  const found = [{ port, project: session.project, self: true }]
  await Promise.allSettled(Array.from({ length: 15 }, (_, i) => 5330 + i).filter(p => p !== port).map(async p => {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/whoami`, { signal: AbortSignal.timeout(300) })
      const j = await r.json()
      if (j && j.project) found.push({ port: p, project: j.project, self: false })
    } catch {}
  }))
  boards = found.sort((a, b) => a.port - b.port)
}
discoverBoards()
for (const t of [3000, 8000]) setTimeout(discoverBoards, t).unref() // cold-start: siblings may not be up yet
setInterval(discoverBoards, 30000).unref()

// ---------- fleet (the zoomed-out altitude) ----------
function summaryModel() {
  return {
    port, project: session.project, hasPlan: planText.length > 0,
    components: parsed.nodes.filter(n => n.level === 'component').map(n => ({ id: n.id, title: n.title, status: n.status, touchedAt: compTouched[n.id] || null })),
    runs: liveRuns().map(r => ({ agent: r.agent, ended: r.ended, componentId: r.componentId, startedAt: r.startedAt, tool: r.currentTool ? `${r.currentTool.name} · ${r.currentTool.detail}` : null, todos: (r.todos || []).length, todosDone: (r.todos || []).filter(t => t.status === 'completed').length })),
    activity,
  }
}
function liteModel() {
  const m = model()
  const { tree, treeTruncated, ...rest } = m
  return { ...rest, port, project: session.project }
}
let worldCache = { at: 0, data: null }
async function worldModel() {
  if (Date.now() - worldCache.at < 1500 && worldCache.data) return worldCache.data
  const out = []
  await Promise.allSettled(boards.map(async b => {
    if (b.self) { out.push(liteModel()); return }
    try {
      const r = await fetch(`http://127.0.0.1:${b.port}/board-lite`, { signal: AbortSignal.timeout(500) })
      out.push(await r.json())
    } catch {}
  }))
  out.sort((a, b) => a.port - b.port)
  worldCache = { at: Date.now(), data: out }
  return out
}
let fleetCache = { at: 0, data: null }
async function fleetModel() {
  if (Date.now() - fleetCache.at < 1500 && fleetCache.data) return fleetCache.data
  const out = []
  await Promise.allSettled(boards.map(async b => {
    if (b.self) { out.push(summaryModel()); return }
    try {
      const r = await fetch(`http://127.0.0.1:${b.port}/summary`, { signal: AbortSignal.timeout(400) })
      out.push(await r.json())
    } catch {}
  }))
  out.sort((a, b) => a.port - b.port)
  fleetCache = { at: Date.now(), data: out }
  return out
}

// ---------- http ----------
const indexPath = path.join(__dirname, '..', 'public', 'index.html')
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  if (u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' }).end(fs.readFileSync(indexPath, 'utf8'))
  } else if (u.pathname === '/whoami') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ project: session.project, port, repoPath: repo }))
  } else if (u.pathname === '/board-lite') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(liteModel()))
  } else if (u.pathname === '/world') {
    worldModel().then(d => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(d)))
  } else if (u.pathname === '/tree') {
    if (treeDirty) { tree = buildTree(repo); treeDirty = false }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ tree, treeTruncated }))
  } else if (u.pathname === '/suggest') {
    const seen = new Set(), out = []
    const add = p => { if (p && p !== repo && !seen.has(p) && fs.existsSync(p)) { seen.add(p); out.push(p) } }
    try {
      const dir = path.join(os.homedir(), '.plantrail')
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue
        try { add(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).repoPath) } catch {}
      }
    } catch {}
    try {
      for (const sib of fs.readdirSync(path.dirname(repo), { withFileTypes: true })) {
        if (!sib.isDirectory()) continue
        const p = path.join(path.dirname(repo), sib.name)
        if (p !== repo && fs.existsSync(path.join(p, '.git'))) add(p)
      }
    } catch {}
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out.slice(0, 15)))
  } else if (u.pathname === '/setup' && req.method === 'POST') {
    res.writeHead(410, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'Plantrail reads existing Superpowers plans; create or edit plans with your planning workflow.' }))
  } else if (u.pathname === '/setup-board' && req.method === 'POST') {
    let body = ''
    req.on('data', c => body += c)
    req.on('end', async () => {
      let out = { ok: false, error: 'no board there' }
      try {
        const p = Number(JSON.parse(body).port)
        out = await fetch(`http://127.0.0.1:${p}/setup`, { method: 'POST', signal: AbortSignal.timeout(5000) }).then(r => r.json())
      } catch {}
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out))
    })
  } else if (u.pathname === '/spawn' && req.method === 'POST') {
    let body = ''
    req.on('data', c => body += c)
    req.on('end', async () => {
      let out = { ok: false, error: 'bad request' }
      try {
        const p = path.resolve(String(JSON.parse(body).path || ''))
        if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) out = { ok: false, error: 'not a folder on this machine' }
        else {
          let already = null
          for (const b of boards) {
            try {
              const w = await fetch(`http://127.0.0.1:${b.port}/whoami`, { signal: AbortSignal.timeout(300) }).then(r => r.json())
              if (w.repoPath === p) { already = b.port; break }
            } catch {}
          }
          if (already) out = { ok: true, already }
          else if (spawningPaths.has(p)) out = { ok: true }
          else {
            spawningPaths.add(p); setTimeout(() => spawningPaths.delete(p), 30000)
            const cp = await import('node:child_process')
            const child = cp.spawn(process.execPath, [fileURLToPath(import.meta.url), p, '--no-open'], { detached: true, stdio: 'ignore' })
            child.unref()
            setTimeout(discoverBoards, 2500)
            setTimeout(discoverBoards, 6000)
            out = { ok: true }
          }
        }
      } catch {}
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out))
    })
  } else if (u.pathname === '/nudge') {
    const cwd = u.searchParams.get('cwd') || ''
    const st = planStaleness()
    const mine = searchRoots().some(r => cwd === r || cwd.startsWith(r + path.sep))
    res.writeHead(200, { 'content-type': 'text/plain' }).end(mine && st.stale
      ? `Note from Plantrail: ${path.relative(repo, planPath)} is ${st.minutes} minutes behind the code. Re-check task status and file paths against what you and other sessions actually changed.`
      : '')
  } else if (u.pathname === '/tree-of') {
    const p = parseInt(u.searchParams.get('port'), 10)
    fetch(`http://127.0.0.1:${p}/tree`, { signal: AbortSignal.timeout(1500) })
      .then(r => r.text()).then(t => res.writeHead(200, { 'content-type': 'application/json' }).end(t))
      .catch(() => res.writeHead(502).end('{}'))
  } else if (u.pathname === '/summary') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(summaryModel()))
  } else if (u.pathname === '/fleet') {
    fleetModel().then(d => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(d)))
  } else if (u.pathname === '/model') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(model()))
  } else if (u.pathname === '/select-plan' && req.method === 'POST') {
    let body = ''
    req.on('data', c => body += c)
    req.on('end', () => {
      try {
        const requested = path.resolve(repo, String(JSON.parse(body).path || ''))
        if (!availablePlans().includes(requested)) {
          res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'unknown plan' }))
          return
        }
        planPath = requested
        planText = safeRead(planPath)
        parsed = parseTrackedPlan(planText, planPath)
        planMtime = statMtime(planPath)
        for (const key of Object.keys(compTouched)) delete compTouched[key]
        for (const key of Object.keys(compRecent)) delete compRecent[key]
        rebuildMatchers()
        broadcast()
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, planFile: path.relative(repo, planPath) }))
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'invalid request' }))
      }
    })
  } else if (u.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    res.write(`data: ${JSON.stringify(model())}\n\n`)
    clients.add(res)
    req.on('close', () => clients.delete(res))
  } else if (u.pathname === '/hook' && req.method === 'POST') {
    let body = ''
    req.on('data', c => body += c)
    req.on('end', () => {
      try { if (handleHookEvent(JSON.parse(body))) hookTick() } catch {}
      res.writeHead(200).end()
    })
  } else res.writeHead(404).end()
})
let lastHookTick = 0
function hookTick() {
  const now = Date.now()
  if (now - lastHookTick > 300) { lastHookTick = now; broadcastTick() }
}
function listenWithFallback(tries = 20) {
  server.once('error', e => {
    if (e.code === 'EADDRINUSE' && tries > 0) { port += 1; listenWithFallback(tries - 1) }
    else { console.error('could not bind a port:', e.message); process.exit(1) }
  })
  server.listen(port, '127.0.0.1', onListen)
}
function onListen() {
  console.log(`plantrail · ${session.project} · ${path.relative(repo, planPath)} · http://localhost:${port}`)
  if (!planText) console.log(`no Superpowers plan found under ${repo} (looked in docs/superpowers/plans of the repo, its sub-repos and worktrees)`)
  if (openBrowser && !noOpen) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
    import('node:child_process').then(cp => cp.spawn(opener, [`http://localhost:${port}`], { stdio: 'ignore', detached: true }))
  }
}
async function bootDedup() {
  const probes = []
  for (let p = 5330; p < 5345; p++) probes.push(
    fetch(`http://127.0.0.1:${p}/whoami`, { signal: AbortSignal.timeout(400) }).then(r => r.json()).then(w => w.repoPath === repo ? p : null).catch(() => null))
  const hit = (await Promise.all(probes)).find(Boolean)
  if (hit) { console.log(`plantrail is already running for this repo · http://localhost:${hit}`); process.exit(0) }
  listenWithFallback()
}
bootDedup()

// merge our hook relay into the repo's .claude/settings.json so Claude Code
// sessions stream tool calls + todos to the board. Additive and idempotent.
function installHooks() {
  const dir = path.join(repo, '.claude')
  const sp = path.join(dir, 'settings.local.json')
  let cfg = {}
  try { cfg = JSON.parse(fs.readFileSync(sp, 'utf8')) } catch {}
  const cmd = `node ${JSON.stringify(fileURLToPath(import.meta.url))} hook`
  cfg.hooks = cfg.hooks || {}
  let added = 0
  for (const ev of ['PreToolUse', 'PostToolUse', 'Stop', 'SessionStart', 'SubagentStop']) {
    const list = cfg.hooks[ev] = cfg.hooks[ev] || []
    const present = JSON.stringify(list).includes('plantrail')
    if (!present) { list.push({ matcher: '*', hooks: [{ type: 'command', command: cmd }] }); added++ }
  }
  if (added) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(sp, JSON.stringify(cfg, null, 2) + '\n')
    console.log(`wired ${added} claude code hooks into .claude/settings.local.json (live tool + todo stream)`)
  }
}

// ---------- lifecycle: resurrect known boards / start at login ----------
async function upAll() {
  const dir = path.join(os.homedir(), '.plantrail')
  let entries = []
  try { entries = fs.readdirSync(dir).filter(f => f.endsWith('.json')) } catch {}
  const known = []
  for (const f of entries) {
    try {
      const st = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
      if (st.repoPath && fs.existsSync(st.repoPath)) known.push({ repo: st.repoPath, port: st.port || 5330 })
    } catch {}
  }
  if (!known.length) { console.log('no known repos yet — run plantrail in a repo first'); return }
  const cp = await import('node:child_process')
  for (const k of known) {
    const live = await fetch(`http://127.0.0.1:${k.port}/whoami`, { signal: AbortSignal.timeout(300) }).then(r => r.json()).catch(() => null)
    if (live) { console.log(`already up: ${k.repo} (:${k.port})`); continue }
    const child = cp.spawn(process.execPath, [fileURLToPath(import.meta.url), k.repo, '--port', String(k.port), '--no-open'], { detached: true, stdio: 'ignore' })
    child.unref()
    console.log(`started: ${k.repo} (:${k.port})`)
  }
}
function autostart() {
  const self = fileURLToPath(import.meta.url)
  if (process.platform === 'darwin') {
    const label = 'dev.plantrail.' + crypto.createHash('sha1').update(repo).digest('hex').slice(0, 8)
    const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>${label}</string>\n  <key>ProgramArguments</key><array><string>${process.execPath}</string><string>${self}</string><string>${repo}</string><string>--port</string><string>${String(port)}</string><string>--no-open</string></array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n</dict></plist>\n`
    const dest = path.join(os.homedir(), 'Library', 'LaunchAgents', label + '.plist')
    if (printFlag) { console.log(plist); return }
    if (removeFlag) {
      try { fs.unlinkSync(dest); console.log('removed', dest, '— run: launchctl unload', dest) } catch { console.log('nothing to remove') }
      return
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, plist)
    console.log(`wrote ${dest}\nactivate now:  launchctl load ${dest}\nthe board for ${repo} will start at every login and restart if it dies.`)
  } else if (process.platform === 'linux') {
    const name = 'plantrail-' + crypto.createHash('sha1').update(repo).digest('hex').slice(0, 8)
    const unit = `[Unit]\nDescription=plantrail board for ${repo}\n\n[Service]\nExecStart=${process.execPath} ${self} ${repo} --port ${String(port)} --no-open\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n`
    const dest = path.join(os.homedir(), '.config', 'systemd', 'user', name + '.service')
    if (printFlag) { console.log(unit); return }
    if (removeFlag) { try { fs.unlinkSync(dest); console.log('removed', dest) } catch { console.log('nothing to remove') } return }
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, unit)
    console.log(`wrote ${dest}\nactivate now:  systemctl --user enable --now ${name}`)
  } else console.log('autostart: macOS and Linux only for now — on Windows, add "plantrail up" to your startup apps')
}
