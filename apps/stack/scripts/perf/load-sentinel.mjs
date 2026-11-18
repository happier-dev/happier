import { SDK_PUBLICATION_SPEC_GRAPH, loadSdkPublicationSpec } from './sdk-publication-spec.mjs';
import { HEAD_DAEMON_BOOT_GRAPH, loadHeadDaemonBoot } from './head-daemon-boot.mjs';
import { resolveSourceRevisionIdentity } from '../build/source_revision.mjs';
import { execFileSync } from 'node:child_process';
import { SCHEMA_SYNC_GRAPH, TRACKED_MIGRATIONS_GRAPH, loadSchemaSync, loadTrackedMigrations } from './schema-migration-probes.mjs';
import { BUNDLED_MANIFEST_GRAPH, loadBundledManifestContracts } from './contract-manifests.mjs';
import { WEB_BUNDLE_GRAPH, loadWebBundle } from './web-bundle.mjs';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ENTRY_GRAPHS, loadEntryGraph } from './entry-load.mjs';
import { isPublicRuntimeImportDiagnostic } from '../utils/proc/runtimeImportProbe.mjs';
import { createFileChangeObserver, DEFAULT_FILE_CHANGE_CATCH_UP_MS } from '../../../../packages/cli-common/fileChangeObserver.mjs';
import { loadDevTargetsConfig } from '../utils/dev_targets/config.mjs';
import { inspectDevTargetAdmission, watchDevTargetAdmission } from '../utils/dev_targets/executor.mjs';
import { resolveRepoStackIdentity, resolveStacksStorageRoot } from '../utils/stack/repo_stack_identity.mjs';
import { readJsonIfExists, writeJsonAtomic } from '../utils/fs/json.mjs';

// The sentinel's own status directory: pass history and the overrun ledger.
const STATUS_DIR = '.project/tmp/load-sentinel';

export function sentinelGraphs() {
  // The incident corridor; entry paths, loaders and execution stay with the owner.
  const ids = ['protocol-import-cycles', 'ui-catalog', 'server', 'daemon'];
  return [...ENTRY_GRAPHS.filter(graph => ids.includes(graph.id)).sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)), WEB_BUNDLE_GRAPH, SCHEMA_SYNC_GRAPH, TRACKED_MIGRATIONS_GRAPH, BUNDLED_MANIFEST_GRAPH, SDK_PUBLICATION_SPEC_GRAPH, HEAD_DAEMON_BOOT_GRAPH];
}

export function isSentinelSource(filename) {
  const path = String(filename ?? '').replaceAll('\\', '/');
  // Directory moves are source changes too: fs.watch may name only the folder.
  return !path.split('/').some(part => ['node_modules', 'dist', 'generated', 'build', '.expo', '.project'].includes(part));
}

// Publish identifiers only, never loader messages, source lines or stack traces.
function identifier(value) {
  return isPublicRuntimeImportDiagnostic(value) && /^[A-Za-z_$][\w$]*$/.test(value) ? value : 'unavailable';
}

function failureIdentity(result) {
  const message = result.loadError?.message ?? '';
  const symbol = message.match(/Cannot access ['"]([^'"]+)['"] before initialization|export named ['"]([^'"]+)['"]|['"]([^'"]+)['"] is not exported|\b([A-Za-z_$][\w$]*) is not defined/)?.slice(1).find(Boolean);
  return { code: identifier(result.loadError?.code ?? result.loadError?.name),
    symbol: identifier(result.loadError?.symbol ?? symbol) };
}

export function formatLoadSentinelResult(result) {
  return { graph: result.graph, status: result.status, elapsedMs: result.elapsedMs,
    ...(result.revision ? { revision: result.revision } : {}),
    startedAt: result.startedAt, endedAt: result.endedAt,
    ...(result.status === 'passed' ? {} : { code: failureIdentity(result).code }) };
}

function sourcePath(repoDir, value) {
  if (!value) return null;
  const path = relative(repoDir, resolve(repoDir, value)).replaceAll('\\', '/');
  if (!isPublicRuntimeImportDiagnostic(path) || isAbsolute(path) || path.startsWith('../') || !/^(apps|packages)\/[\w./@ -]+$/.test(path)
    || !isSentinelSource(path)) return null;
  return path;
}

async function recentImportFiles(repoDir, graph, result) {
  const target = resolve(repoDir, result.firstFailingModule ?? graph.entry);
  const entry = resolve(repoDir, graph.entry);
  const edges = new Map();
  for (const [from, to] of result.importEdges ?? []) {
    if (!edges.has(from)) edges.set(from, []);
    edges.get(from).push(to);
  }
  const parents = new Map([[entry, null]]);
  const queue = [entry];
  for (let index = 0; index < queue.length && !parents.has(target); index++) {
    for (const next of edges.get(queue[index]) ?? []) if (!parents.has(next)) {
      parents.set(next, queue[index]); queue.push(next);
    }
  }
  const path = [];
  if (result.failureImportPath) path.push(...result.failureImportPath);
  else if (parents.has(target)) {
    for (let file = target; file; file = parents.get(file)) path.push(file);
  } else path.push(target); // Some bundlers resolve outside Node; do not invent a chain.
  const files = [];
  for (const file of new Set(path)) {
    const name = sourcePath(repoDir, file);
    if (!name) continue;
    try { files.push({ path: name, mtimeMs: (await stat(join(repoDir, name))).mtimeMs }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { files: files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 3),
    complete: Boolean(result.failureImportPath) || parents.has(target) };
}

// The broker flags a slot at 2× its recorded p99. A flag alone is ledger
// material: the board hears about it only when the slot is still running a
// further 2× p99 later AND the same fresh broker observation has waiters it
// blocks (2026-11-14..16: 258 flags posted, 8 acted on).
const OVERRUN_ESCALATION_P99_MULTIPLE = 4;
// Breaks clear in a median ~5 min; the attributed writer gets them first.
export const BREAK_ESCALATION_MS = 10 * 60_000;

export function createLoadSentinel({ repoDir, graphs = sentinelGraphs(), signal, env = process.env, post, onResult = () => {},
  runHeadBootCommand,
  readAdmissionSamples = async () => [],
  readAdmissionStatus = async () => null,
  attributeBreak = async () => null,
  breakEscalationMs = BREAK_ESCALATION_MS,
  waitForQuiet = () => delay(DEFAULT_FILE_CHANGE_CATCH_UP_MS, undefined, { signal }) }) {
  const checkedHeads = new Set();
  const timers = new Set();
  signal?.addEventListener('abort', () => { for (const timer of timers) clearTimeout(timer); timers.clear(); }, { once: true });
  function after(ms, callback) {
    if (signal?.aborted) return;
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, Math.max(0, ms));
    timer.unref?.();
    timers.add(timer);
  }
  // A HEAD boot can take many minutes under load; it runs beside the source
  // cycle so per-lane post-write gates never wait behind it.
  let headRunning;
  let headPending = false;
  // Overrun ledger: every flagged slot lands in the sentinel's status file;
  // escalated slots stay recorded across restarts so none is posted twice.
  const overrunStatusPath = join(repoDir, STATUS_DIR, 'OVERRUNS.json');
  let escalatedOverruns;
  const activeOverruns = new Map();
  const evaluatedSamples = new Map();
  let writtenOverrunState = '';
  let admissionPending = false;
  let admissionRunning;
  let overrunCheckAt = Infinity;
  let overrunCheckRunning;
  async function loadOverrunLedger() {
    if (escalatedOverruns) return;
    const status = await readJsonIfExists(overrunStatusPath);
    // `announced` is the pre-ledger name for slots already posted.
    escalatedOverruns = new Map(Object.entries({ ...status?.announced, ...status?.escalated }));
    for (const row of status?.active ?? []) if (row?.target && row?.slotId && row.firstSeenAt) {
      activeOverruns.set(`${row.target}/${row.slotId}`, row);
    }
  }
  async function evaluateSample(sample, fresh) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(sample.target ?? '') || !Array.isArray(sample.overruns)) return;
    const observedAt = Number.isFinite(sample.observedAt) ? sample.observedAt : Date.now();
    // A successor can report an empty snapshot before retained client
    // metadata arrives, so absence never forgets an escalated slot.
    const previous = new Map([...activeOverruns].filter(([key]) => key.startsWith(`${sample.target}/`)));
    for (const key of previous.keys()) activeOverruns.delete(key);
    const waitingCount = Number.isSafeInteger(sample.waitingCount) ? sample.waitingCount : 0;
    for (const slot of sample.overruns) {
      if (!/^[a-f0-9-]{36}$/.test(slot.slotId ?? '') || !/^[a-z][a-z0-9-]*$/.test(slot.durationClass ?? '')
        || !Number.isFinite(slot.ageMs) || !Number.isFinite(slot.p99DurationMs) || !(slot.p99DurationMs > 0)) continue;
      const key = `${sample.target}/${slot.slotId}`;
      const escalateAtAgeMs = OVERRUN_ESCALATION_P99_MULTIPLE * slot.p99DurationMs;
      const row = { target: sample.target, slotId: slot.slotId, durationClass: slot.durationClass,
        ageMs: slot.ageMs, recordedP99Ms: slot.p99DurationMs, waitingCount,
        firstSeenAt: previous.get(key)?.firstSeenAt ?? new Date(observedAt).toISOString() };
      activeOverruns.set(key, row);
      if (escalatedOverruns.has(key)) continue;
      // Only a fresh observation proves the slot blocks waiters right now:
      // the broker's push identity omits waitingCount.
      if (fresh && slot.ageMs >= escalateAtAgeMs && waitingCount > 0) {
        const details = `target=${sample.target}; slot=${slot.slotId}; class=${slot.durationClass}; ageMs=${slot.ageMs}; recordedP99Ms=${slot.p99DurationMs}; waiting=${waitingCount}`;
        if (await announce('admission', 'overrun', details)) escalatedOverruns.set(key, new Date().toISOString());
        continue;
      }
      // Re-observe at the escalation age, or one recorded p99 later when the
      // slot is past it with nobody waiting. A blocked waiter never triggers a
      // push, and the slot's completion (activeCount change) does.
      scheduleOverrunCheck(observedAt + Math.max(escalateAtAgeMs - slot.ageMs, slot.ageMs >= escalateAtAgeMs ? slot.p99DurationMs : 0));
    }
  }
  function scheduleOverrunCheck(at) {
    if (at >= overrunCheckAt) return;
    overrunCheckAt = at;
    after(at - Date.now(), () => {
      if (overrunCheckAt !== at) return;
      overrunCheckAt = Infinity;
      overrunCheckRunning = (async () => {
        await admissionRunning;
        const targets = new Set([...activeOverruns.values()].filter(row => !escalatedOverruns.has(`${row.target}/${row.slotId}`)).map(row => row.target));
        for (const target of targets) {
          const sample = await readAdmissionStatus(target);
          if (sample && !signal?.aborted) await evaluateSample({ ...sample, target, observedAt: Date.now() }, true);
        }
        await writeOverrunLedger();
      })().catch(error => {
        const code = error?.code ?? error?.name;
        console.error(JSON.stringify({ event: 'load-sentinel-overrun-check-failed',
          code: isPublicRuntimeImportDiagnostic(code) && /^[\w-]+$/.test(code) ? code : 'redacted' }));
      }).finally(() => { overrunCheckRunning = undefined; });
    });
  }
  async function writeOverrunLedger() {
    const state = JSON.stringify({ active: [...activeOverruns.values()].map(({ ageMs, waitingCount, ...row }) => row),
      escalated: Object.fromEntries(escalatedOverruns) });
    if (state === writtenOverrunState) return;
    await writeJsonAtomic(overrunStatusPath, { updatedAt: new Date().toISOString(),
      active: [...activeOverruns.values()], escalated: Object.fromEntries(escalatedOverruns) });
    writtenOverrunState = state;
  }
  async function sampleAdmissions() {
    await loadOverrunLedger();
    do {
      admissionPending = false;
      for (const sample of await readAdmissionSamples()) {
        // A pushed sample is fresh once; source cycles re-read the same object.
        const fresh = !Number.isFinite(sample.observedAt) || evaluatedSamples.get(sample.target) !== sample.observedAt;
        evaluatedSamples.set(sample.target, sample.observedAt);
        await evaluateSample(sample, fresh);
      }
      await writeOverrunLedger();
    } while (admissionPending && !signal?.aborted);
  }
  function requestAdmissionSample() {
    admissionPending = true;
    if (!admissionRunning) admissionRunning = sampleAdmissions().finally(() => { admissionRunning = undefined; });
    return admissionRunning;
  }
  // Break ledger: one record per red graph, kept across restarts, so a graph
  // that stays red posts once (its first break) until it passes again.
  const breakStatusPath = join(repoDir, STATUS_DIR, 'BREAKS.json');
  let breaks;
  async function loadBreaks() {
    if (breaks) return;
    breaks = new Map(Object.entries((await readJsonIfExists(breakStatusPath))?.breaks ?? {}));
    for (const [graphId, record] of breaks) if (!record.escalatedAt) scheduleBreakEscalation(graphId, record);
  }
  const writeBreaks = () => writeJsonAtomic(breakStatusPath, { updatedAt: new Date().toISOString(), breaks: Object.fromEntries(breaks) });
  function scheduleBreakEscalation(graphId, record) {
    after(Date.parse(record.since) + breakEscalationMs - Date.now(), async () => {
      try {
        // Let an in-flight cycle observe a repair first.
        await running;
        const current = breaks.get(graphId);
        if (current !== record || current.escalatedAt || signal?.aborted) return;
        const details = `${current.details}\n- First sent to ${current.notified} at ${current.since}; still red after ${Math.round(breakEscalationMs / 60_000)} min.`;
        if (await announce(graphId, 'broken', details, 'ALL leads')) {
          current.escalatedAt = new Date().toISOString();
          await writeBreaks();
        } else scheduleBreakEscalation(graphId, record);
      } catch (error) {
        const code = error?.code ?? error?.name;
        console.error(JSON.stringify({ event: 'load-sentinel-break-escalation-failed', graph: graphId,
          code: isPublicRuntimeImportDiagnostic(code) && /^[\w-]+$/.test(code) ? code : 'redacted' }));
      }
    });
  }
  async function recordBroken(graph, details, attribution) {
    await loadBreaks();
    const existing = breaks.get(graph.id);
    if (existing) {
      if (existing.details !== details) { existing.details = details; await writeBreaks(); }
      return;
    }
    const attributed = await attributeBreak(attribution);
    const notified = attributed?.lane ?? 'ORCH-TOP';
    const deadline = new Date(Date.now() + breakEscalationMs).toISOString().slice(11, 16);
    const routed = `${details}\n- ${attributed ? `Attributed to ${attributed.lane} (${attributed.basis}).` : 'No lane attributed.'} Goes to ALL leads at ${deadline}Z if still red.`;
    if (!await announce(graph.id, 'broken', routed, notified)) return;
    const record = { since: new Date().toISOString(), details, notified, escalatedAt: null };
    breaks.set(graph.id, record);
    await writeBreaks();
    scheduleBreakEscalation(graph.id, record);
  }
  async function recordPassed(graph) {
    await loadBreaks();
    const record = breaks.get(graph.id);
    if (!record) return;
    // Only someone who was alarmed needs the clear; a writer that repaired its
    // own break inside the window already knows.
    if ((record.escalatedAt || record.notified === 'ORCH-TOP') && !await announce(graph.id, 'cleared', record.details)) return;
    breaks.delete(graph.id);
    await writeBreaks();
  }
  async function load(graph) {
    const startedAt = new Date().toISOString();
    let result;
    if (graph.id === WEB_BUNDLE_GRAPH.id) result = await loadWebBundle({ repoDir, signal, env });
    else if (graph.id === SCHEMA_SYNC_GRAPH.id) result = await loadSchemaSync({ repoDir, signal, env });
    else if (graph.id === TRACKED_MIGRATIONS_GRAPH.id) result = await loadTrackedMigrations({ repoDir, signal, env });
    else if (graph.id === BUNDLED_MANIFEST_GRAPH.id) result = await loadBundledManifestContracts({ repoDir, signal, env });
    else if (graph.id === SDK_PUBLICATION_SPEC_GRAPH.id) result = await loadSdkPublicationSpec({ repoDir, signal, env });
    else result = await loadEntryGraph(graph, { repoDir, signal, env, traceImports: true });
    return { ...result, startedAt, endedAt: new Date().toISOString() };
  }
  let pending = false;
  let running;
  let notice = 0;
  async function announce(graph, state, details, recipient) {
    try {
      await post(formatPost(graph, state, details, ++notice, recipient));
      return true;
    } catch (error) {
      // Publication is best effort; only successful posts advance announced state.
      // Never print writer messages, which can contain private paths or entry bytes.
      const code = error?.code ?? error?.name;
      console.error(JSON.stringify({ event: 'load-sentinel-board-write-failed', graph, state,
        code: isPublicRuntimeImportDiagnostic(code) && /^[\w-]+$/.test(code) ? code : 'redacted' }));
      return false;
    }
  }
  async function checkHead(graph) {
    while (headPending && !signal?.aborted) {
      headPending = false;
      const { revision } = await resolveSourceRevisionIdentity({ repoDir, rev: 'HEAD' });
      if (checkedHeads.has(revision)) continue;
      checkedHeads.add(revision);
      const startedAt = new Date().toISOString();
      const result = { ...await loadHeadDaemonBoot({ repoDir, revision, env, signal, runCommand: runHeadBootCommand }),
        startedAt, endedAt: new Date().toISOString() };
      await onResult(result);
      if (result.status === 'passed') { await recordPassed(graph); continue; }
      const message = String(result.loadError?.message ?? 'HEAD boot failed').split('\n')[0];
      const file = sourcePath(repoDir, result.firstFailingModule) ?? graph.entry;
      const details = `graph=${graph.id}; revision=${revision}; file=${file}; error=${isPublicRuntimeImportDiagnostic(message) ? message : 'private diagnostic withheld'}`;
      let mtimeMs = 0;
      try { mtimeMs = (await stat(join(repoDir, file))).mtimeMs; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await recordBroken(graph, details, { graph: graph.id, files: [{ path: file, mtimeMs }], module: file, line: result.failureLine });
    }
  }
  async function run() {
    do {
      pending = false;
      await requestAdmissionSample();
      await loadBreaks();
      for (const graph of graphs) {
        signal?.throwIfAborted();
        if (graph.id === HEAD_DAEMON_BOOT_GRAPH.id) {
          headPending = true;
          if (!headRunning) headRunning = checkHead(graph).finally(() => { headRunning = undefined; });
          continue;
        }
        let result = await load(graph);
        await onResult(result);
        if (result.status === 'unavailable') continue;
        if (result.status !== 'passed' && !breaks.has(graph.id)) {
          // Multi-file writes can briefly break imports. Confirm only this graph
          // after a fresh quiet window before alarming anyone.
          await waitForQuiet();
          signal?.throwIfAborted();
          result = await load(graph);
          await onResult(result);
        }
        if (result.status === 'unavailable') continue;
        if (result.status === 'passed') { await recordPassed(graph); continue; }
        const { code, symbol } = failureIdentity(result);
        const module = sourcePath(repoDir, result.firstFailingModule) ?? graph.entry;
        const recent = await recentImportFiles(repoDir, graph, result);
        const location = result.failureLine ? `${module}:${result.failureLine}` : module;
        const details = `graph=${graph.id}; importing module=${location}; code=${code}; symbol=${symbol}\n`
          + recent.files.map(file => `- ${file.path} — ${new Date(file.mtimeMs).toISOString()}`).join('\n')
          + (recent.complete ? '' : '\n- Import trace incomplete; only the observed failing module is attributed.');
        await recordBroken(graph, details, { graph: graph.id, files: recent.files, module, line: result.failureLine });
      }
    } while (pending && !signal?.aborted);
  }
  return {
    sampleAdmissions: requestAdmissionSample,
    request() {
      pending = true;
      if (!running) running = run().finally(() => { running = undefined; });
      // Callers settle once the source cycle and any HEAD boot it started are done.
      return running.then(() => headRunning);
    },
    async idle() { await Promise.all([running, admissionRunning, headRunning, overrunCheckRunning]); },
  };
}

function formatPost(graph, state, details, notice, recipient) {
  const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  // Only the broker owner can map a slot to its caller, so an overrun is its flag, not a fleet alarm.
  if (state === 'overrun') return `### ${timestamp} UTC — LOAD-SENTINEL-1110 → Systemic (overruns) — ASK — admission overrun blocking waiters [${process.pid}:${notice}]\n`
    + '- Systemic: this slot runs past 4× its recorded p99 while others wait; route it to its caller. The broker leaves it running.\n'
    + `${details}\n`;
  // Board readers remember whole headings; distinguish same-minute transitions.
  if (state === 'broken') return `### ${timestamp} UTC — LOAD-SENTINEL-1110 → ${recipient} — URGENT — ${graph} broken [${process.pid}:${notice}]\n`
    + `- ${recipient === 'ALL leads' ? 'Still red: inspect' : `${recipient}: your write is the likely cause; inspect`} the named import path and repair the shared-source load break.\n`
    + `${details}\n`;
  // An ASK: ORCH-TOP must act, and the board writer refuses orchestrator-only RESULTs.
  return `### ${timestamp} UTC — LOAD-SENTINEL-1110 → ORCH-TOP — ASK — ${graph} cleared [${process.pid}:${notice}]\n`
    + '- ORCH-TOP: release any reload hold for this cleared break.\n'
    + `${details}\n`;
}

async function configuredTargets({ repoDir, env }) {
  const { stackBaseDir } = resolveRepoStackIdentity({ repoRoot: repoDir, stacksStorageRoot: resolveStacksStorageRoot(env) });
  const { config } = await loadDevTargetsConfig({ path: join(stackBaseDir, 'dev-targets.json'), env });
  return { stackBaseDir, targets: config.targets.filter(target => target.platform === 'posix') };
}

// One read-only broker observation for an overrun's escalation deadline.
async function readConfiguredAdmissionStatus({ repoDir, env, target: name }) {
  const target = (await configuredTargets({ repoDir, env })).targets.find(item => item.name === name);
  if (!target) return null;
  const status = await inspectDevTargetAdmission({ target, env });
  return status?.state === 'observed' ? status : null;
}

async function watchConfiguredAdmissions({ repoDir, env, signal, onSample }) {
  const { stackBaseDir, targets } = await configuredTargets({ repoDir, env });
  await Promise.all(targets.map(async target => {
    try {
      await watchDevTargetAdmission({ target, stackBaseDir, env, signal,
        onSample: sample => onSample({ ...sample, target: target.name }) });
    } catch (error) {
      if (signal.aborted) return;
      const code = error?.code ?? error?.name;
      console.error(JSON.stringify({ event: 'load-sentinel-admission-watch-unavailable', target: target.name,
        code: isPublicRuntimeImportDiagnostic(code) && /^[\w-]+$/.test(code) ? code : 'redacted' }));
    }
  }));
}

export async function watchLoadSentinel({ repoDir, signal, post, onResult, graphs, env = process.env,
  runHeadBootCommand, watchAdmissions = watchConfiguredAdmissions, readAdmissionStatus = readConfiguredAdmissionStatus,
  attributeBreak }) {
  let debounce;
  let quiet;
  let requestAfterQuiet = false;
  let failure;
  const stopped = Promise.withResolvers();
  const observer = createFileChangeObserver(['apps', 'packages'].map(dir => join(repoDir, dir)), {
    recursive: true, persistent: true, isRelevant: (_directory, filename) => isSentinelSource(filename),
    onError: error => { failure = error; stopped.resolve(); },
  });
  // Commits normally leave source bytes unchanged. Follow the reflog's parent
  // directory so update-ref's atomic replacement also reaches the observer.
  const headObserver = (graphs ?? sentinelGraphs()).some(graph => graph.id === HEAD_DAEMON_BOOT_GRAPH.id)
    ? createFileChangeObserver([execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'logs'],
      { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()], {
      persistent: true, isRelevant: (_directory, filename) => String(filename) === 'HEAD',
      onError: error => { failure = error; stopped.resolve(); },
    }) : null;
  const abort = () => { quiet?.resolve(); stopped.resolve(); };
  const request = () => sentinel.request().catch(error => { failure = error; stopped.resolve(); });
  // Source-triggered runs and confirmation share the existing debounce. Every
  // relevant event renews the window, including events while a graph is loading.
  const waitForQuiet = () => {
    clearTimeout(debounce);
    quiet ??= Promise.withResolvers();
    debounce = setTimeout(() => {
      const settled = quiet;
      quiet = undefined;
      settled.resolve();
      if (requestAfterQuiet) { requestAfterQuiet = false; request(); }
    }, DEFAULT_FILE_CHANGE_CATCH_UP_MS);
    return quiet.promise;
  };
  const admissionSamples = new Map();
  const admissionController = new AbortController();
  const abortAdmissions = () => admissionController.abort();
  signal.addEventListener('abort', abortAdmissions, { once: true });
  if (signal.aborted) abortAdmissions();
  const sentinel = createLoadSentinel({ repoDir, signal, post, onResult, graphs, waitForQuiet, env, runHeadBootCommand,
    attributeBreak, readAdmissionStatus: target => readAdmissionStatus({ repoDir, env, target }),
    readAdmissionSamples: async () => [...admissionSamples.values()] });
  // A broker stream is independent of graph checks: launches and clock-only
  // overruns never start expensive source loads or process/memory walks.
  const admissionWatch = watchAdmissions({ repoDir, env, signal: admissionController.signal, onSample: sample => {
    admissionSamples.set(sample.target, { ...sample, observedAt: Date.now() });
    sentinel.sampleAdmissions().catch(error => { failure = error; stopped.resolve(); });
  } }).catch(error => {
    if (signal.aborted) return;
    const code = error?.code ?? error?.name;
    console.error(JSON.stringify({ event: 'load-sentinel-admission-watch-unavailable',
      code: isPublicRuntimeImportDiagnostic(code) && /^[\w-]+$/.test(code) ? code : 'redacted' }));
  });
  signal.addEventListener('abort', abort, { once: true });
  observer.subscribe(() => {
    requestAfterQuiet = true;
    waitForQuiet();
  });
  headObserver?.subscribe(() => {
    requestAfterQuiet = true;
    waitForQuiet();
  });
  try {
    if (!signal.aborted) { await request(); await stopped.promise; }
  } finally {
    clearTimeout(debounce);
    quiet?.resolve();
    observer.close();
    headObserver?.close();
    admissionController.abort();
    signal.removeEventListener('abort', abortAdmissions);
    signal.removeEventListener('abort', abort);
    await sentinel.idle();
    await admissionWatch;
  }
  if (failure && !signal.aborted) throw failure;
}

/** Read the sentinel runner's existing completed verdicts; graph samples and
 * partial/in-progress passes never manufacture a green result. */
export async function readLoadSentinelPasses(repoDir) {
  let history;
  try { history = await readFile(join(repoDir, STATUS_DIR, 'HISTORY.txt'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return history.split('\n').flatMap(line => {
    const match = /^\S+ PASS failed=0 passStartedAt~(\S+) passEndedAt~(\S+) graphs=\d+\s*$/.exec(line);
    if (!match || !Number.isFinite(Date.parse(match[1])) || !(Date.parse(match[2]) >= Date.parse(match[1]))) return [];
    return [{ startedAt: match[1], endedAt: match[2] }];
  });
}
