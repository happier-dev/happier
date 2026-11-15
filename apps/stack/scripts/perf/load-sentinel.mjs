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
import { watchDevTargetAdmission } from '../utils/dev_targets/executor.mjs';
import { resolveRepoStackIdentity, resolveStacksStorageRoot } from '../utils/stack/repo_stack_identity.mjs';

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

export function createLoadSentinel({ repoDir, graphs = sentinelGraphs(), signal, env = process.env, post, onResult = () => {},
  runHeadBootCommand,
  readAdmissionSamples = async () => [],
  waitForQuiet = () => delay(DEFAULT_FILE_CHANGE_CATCH_UP_MS, undefined, { signal }) }) {
  const failures = new Map();
  const checkedHeads = new Set();
  const announcedOverruns = new Map();
  let admissionPending = false;
  let admissionRunning;
  async function sampleAdmissions() {
    do {
      admissionPending = false;
      const samples = await readAdmissionSamples();
      for (const sample of samples) {
        if (!/^[a-z0-9][a-z0-9._-]*$/.test(sample.target ?? '') || !Array.isArray(sample.overruns)) continue;
        const announced = announcedOverruns.get(sample.target) ?? new Set();
        for (const slot of sample.overruns) {
          if (!/^[a-f0-9-]{36}$/.test(slot.slotId ?? '') || !/^[a-z][a-z0-9-]*$/.test(slot.durationClass ?? '')
            || !Number.isFinite(slot.ageMs) || !Number.isFinite(slot.p99DurationMs)) continue;
          if (announced.has(slot.slotId)) continue;
          const details = `target=${sample.target}; slot=${slot.slotId}; class=${slot.durationClass}; ageMs=${slot.ageMs}; recordedP99Ms=${slot.p99DurationMs}`;
          if (await announce('admission', 'overrun', details)) announced.add(slot.slotId);
        }
        // A successor can report an empty snapshot before retained client
        // metadata arrives. Notices remain once per slot for this sentinel.
        if (announced.size) announcedOverruns.set(sample.target, announced);
      }
    } while (admissionPending && !signal?.aborted);
  }
  function requestAdmissionSample() {
    admissionPending = true;
    if (!admissionRunning) admissionRunning = sampleAdmissions().finally(() => { admissionRunning = undefined; });
    return admissionRunning;
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
  async function announce(graph, state, details) {
    try {
      await post(formatPost(graph, state, details, ++notice));
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
  async function run() {
    do {
      pending = false;
      await requestAdmissionSample();
      for (const graph of graphs) {
        signal?.throwIfAborted();
        if (graph.id === HEAD_DAEMON_BOOT_GRAPH.id) {
          const { revision } = await resolveSourceRevisionIdentity({ repoDir, rev: 'HEAD' });
          if (checkedHeads.has(revision)) continue;
          checkedHeads.add(revision);
          const startedAt = new Date().toISOString();
          const result = { ...await loadHeadDaemonBoot({ repoDir, revision, env, signal, runCommand: runHeadBootCommand }),
            startedAt, endedAt: new Date().toISOString() };
          await onResult(result);
          if (result.status !== 'passed') {
            const message = String(result.loadError?.message ?? 'HEAD boot failed').split('\n')[0];
            const details = `graph=${graph.id}; revision=${revision}; file=${sourcePath(repoDir, result.firstFailingModule) ?? graph.entry}; error=${isPublicRuntimeImportDiagnostic(message) ? message : 'private diagnostic withheld'}`;
            await announce(graph.id, 'broken', details);
          }
          continue;
        }
        let result = await load(graph);
        await onResult(result);
        if (result.status === 'unavailable') continue;
        const previous = failures.get(graph.id);
        if (result.status !== 'passed') {
          const { code, symbol } = failureIdentity(result);
          const module = sourcePath(repoDir, result.firstFailingModule) ?? graph.entry;
          if (!previous?.has(JSON.stringify([module, code, symbol]))) {
            // Multi-file writes can briefly break imports. Confirm only this graph
            // after a fresh quiet window before waking every lead.
            await waitForQuiet();
            signal?.throwIfAborted();
            result = await load(graph);
            await onResult(result);
          }
        }
        if (result.status === 'unavailable') continue;
        if (result.status === 'passed') {
          if (previous) {
            for (const [key, details] of previous) {
              if (await announce(graph.id, 'cleared', details)) previous.delete(key);
            }
            if (previous.size === 0) failures.delete(graph.id);
          }
          continue;
        }
        const { code, symbol } = failureIdentity(result);
        const module = sourcePath(repoDir, result.firstFailingModule) ?? graph.entry;
        const key = JSON.stringify([module, code, symbol]);
        if (previous?.has(key)) continue;
        const recent = await recentImportFiles(repoDir, graph, result);
        const location = result.failureLine ? `${module}:${result.failureLine}` : module;
        const details = `graph=${graph.id}; importing module=${location}; code=${code}; symbol=${symbol}\n`
          + recent.files.map(file => `- ${file.path} — ${new Date(file.mtimeMs).toISOString()}`).join('\n')
          + (recent.complete ? '' : '\n- Import trace incomplete; only the observed failing module is attributed.');
        if (!await announce(graph.id, 'broken', details)) continue;
        const activeFailures = previous ?? new Map();
        activeFailures.set(key, details);
        failures.set(graph.id, activeFailures);
      }
    } while (pending && !signal?.aborted);
  }
  return {
    sampleAdmissions: requestAdmissionSample,
    request() {
      pending = true;
      if (!running) running = run().finally(() => { running = undefined; });
      return running;
    },
    async idle() { await Promise.all([running, admissionRunning]); },
  };
}

function formatPost(graph, state, details, notice) {
  const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  // Only the broker owner can map a slot to its caller, so an overrun is its flag, not a fleet alarm.
  if (state === 'overrun') return `### ${timestamp} UTC — LOAD-SENTINEL-1110 → Systemic (overruns) — ASK — admission overrun [${process.pid}:${notice}]\n`
    + '- Systemic: inspect the named admitted slot and route it to its caller; the broker leaves it running.\n'
    + `${details}\n`;
  // Board readers remember whole headings; distinguish same-minute transitions.
  return `### ${timestamp} UTC — LOAD-SENTINEL-1110 → ${state === 'broken' ? 'ALL leads' : 'ORCH-TOP'} — ${state === 'broken' ? 'URGENT' : 'RESULT'} — ${graph} ${state} [${process.pid}:${notice}]\n`
    + `- ${state === 'broken' ? 'Inspect the named import path and repair the shared-source load break.' : 'ORCH-TOP: release any reload hold for this cleared break.'}\n`
    + `${details}\n`;
}

async function watchConfiguredAdmissions({ repoDir, env, signal, onSample }) {
  const { stackBaseDir } = resolveRepoStackIdentity({ repoRoot: repoDir, stacksStorageRoot: resolveStacksStorageRoot(env) });
  const { config } = await loadDevTargetsConfig({ path: join(stackBaseDir, 'dev-targets.json'), env });
  await Promise.all(config.targets.filter(target => target.platform === 'posix').map(async target => {
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
  runHeadBootCommand, watchAdmissions = watchConfiguredAdmissions }) {
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
    readAdmissionSamples: async () => [...admissionSamples.values()] });
  // A broker stream is independent of graph checks: launches and clock-only
  // overruns never start expensive source loads or process/memory walks.
  const admissionWatch = watchAdmissions({ repoDir, env, signal: admissionController.signal, onSample: sample => {
    admissionSamples.set(sample.target, sample);
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
  try { history = await readFile(join(repoDir, '.project/tmp/load-sentinel/HISTORY.txt'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return history.split('\n').flatMap(line => {
    const match = /^\S+ PASS failed=0 passStartedAt~(\S+) passEndedAt~(\S+) graphs=\d+\s*$/.exec(line);
    if (!match || !Number.isFinite(Date.parse(match[1])) || !(Date.parse(match[2]) >= Date.parse(match[1]))) return [];
    return [{ startedAt: match[1], endedAt: match[2] }];
  });
}
