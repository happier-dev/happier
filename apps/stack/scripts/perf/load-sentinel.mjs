import { SDK_PUBLICATION_SPEC_GRAPH, loadSdkPublicationSpec } from './sdk-publication-spec.mjs';
import { SCHEMA_SYNC_GRAPH, TRACKED_MIGRATIONS_GRAPH, loadSchemaSync, loadTrackedMigrations } from './schema-migration-probes.mjs';
import { BUNDLED_MANIFEST_GRAPH, loadBundledManifestContracts } from './contract-manifests.mjs';
import { WEB_BUNDLE_GRAPH, loadWebBundle } from './web-bundle.mjs';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ENTRY_GRAPHS, loadEntryGraph } from './entry-load.mjs';
import { isPublicRuntimeImportDiagnostic } from '../utils/proc/runtimeImportProbe.mjs';
import { createFileChangeObserver, DEFAULT_FILE_CHANGE_CATCH_UP_MS } from '../../../../packages/cli-common/fileChangeObserver.mjs';

export function sentinelGraphs() {
  // The incident corridor; entry paths, loaders and execution stay with the owner.
  const ids = ['protocol-import-cycles', 'ui-catalog', 'server', 'daemon'];
  return [...ENTRY_GRAPHS.filter(graph => ids.includes(graph.id)).sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)), WEB_BUNDLE_GRAPH, SCHEMA_SYNC_GRAPH, TRACKED_MIGRATIONS_GRAPH, BUNDLED_MANIFEST_GRAPH, SDK_PUBLICATION_SPEC_GRAPH];
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
  waitForQuiet = () => delay(DEFAULT_FILE_CHANGE_CATCH_UP_MS, undefined, { signal }) }) {
  const failures = new Map();
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
      for (const graph of graphs) {
        signal?.throwIfAborted();
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
    request() {
      pending = true;
      if (!running) running = run().finally(() => { running = undefined; });
      return running;
    },
    async idle() { await running; },
  };
}

function formatPost(graph, state, details, notice) {
  const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  // Board readers remember whole headings; distinguish same-minute transitions.
  return `### ${timestamp} UTC — LOAD-SENTINEL-1110 → ${state === 'broken' ? 'ALL leads' : 'ORCH-TOP'} — ${state === 'broken' ? 'URGENT' : 'RESULT'} — ${graph} ${state} [${process.pid}:${notice}]\n`
    + `- ${state === 'broken' ? 'Inspect the named import path and repair the shared-source load break.' : 'ORCH-TOP: release any reload hold for this cleared break.'}\n`
    + `${details}\n`;
}

export async function watchLoadSentinel({ repoDir, signal, post, onResult, graphs }) {
  let debounce;
  let quiet;
  let requestAfterQuiet = false;
  let failure;
  const stopped = Promise.withResolvers();
  const observer = createFileChangeObserver(['apps', 'packages'].map(dir => join(repoDir, dir)), {
    recursive: true, persistent: true, isRelevant: (_directory, filename) => isSentinelSource(filename),
    onError: error => { failure = error; stopped.resolve(); },
  });
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
  const sentinel = createLoadSentinel({ repoDir, signal, post, onResult, graphs, waitForQuiet });
  signal.addEventListener('abort', abort, { once: true });
  observer.subscribe(() => {
    requestAfterQuiet = true;
    waitForQuiet();
  });
  try {
    if (!signal.aborted) { await request(); await stopped.promise; }
  } finally {
    clearTimeout(debounce);
    quiet?.resolve();
    observer.close();
    signal.removeEventListener('abort', abort);
    await sentinel.idle();
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
