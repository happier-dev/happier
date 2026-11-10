import { stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { ENTRY_GRAPHS, loadEntryGraph } from './entry-load.mjs';
import { isPublicRuntimeImportDiagnostic } from '../utils/proc/runtimeImportProbe.mjs';
import { createFileChangeObserver, DEFAULT_FILE_CHANGE_CATCH_UP_MS } from '../../../../packages/cli-common/fileChangeObserver.mjs';

export function sentinelGraphs() {
  // The incident corridor; entry paths, loaders and execution stay with the owner.
  const ids = ['protocol-import-cycles', 'ui-catalog', 'server', 'daemon'];
  return ENTRY_GRAPHS.filter(graph => ids.includes(graph.id)).sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
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

export function createLoadSentinel({ repoDir, graphs = sentinelGraphs(), signal, post, onResult = () => {} }) {
  const failures = new Map();
  let pending = false;
  let running;
  let notice = 0;
  const announce = (graph, state, details) => post(formatPost(graph, state, details, ++notice));
  async function run() {
    do {
      pending = false;
      for (const graph of graphs) {
        signal?.throwIfAborted();
        const result = await loadEntryGraph(graph, { repoDir, signal, traceImports: true });
        onResult(result);
        const previous = failures.get(graph.id);
        if (result.status === 'passed') {
          if (previous) {
            for (const [key, details] of previous) {
              await announce(graph.id, 'cleared', details);
              previous.delete(key);
            }
            failures.delete(graph.id);
          }
          continue;
        }
        const { code, symbol } = failureIdentity(result);
        const module = sourcePath(repoDir, result.firstFailingModule) ?? graph.entry;
        const key = JSON.stringify([module, code, symbol]);
        if (previous?.has(key)) continue;
        const recent = await recentImportFiles(repoDir, graph, result);
        const details = `graph=${graph.id}; importing module=${module}; code=${code}; symbol=${symbol}\n`
          + recent.files.map(file => `- ${file.path} — ${new Date(file.mtimeMs).toISOString()}`).join('\n')
          + (recent.complete ? '' : '\n- Import trace incomplete; only the observed failing module is attributed.');
        await announce(graph.id, 'broken', details);
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
  return `### ${timestamp} UTC — LOAD-SENTINEL-1110 → ALL leads — URGENT — ${graph} ${state} [${process.pid}:${notice}]\n`
    + `- ${state === 'broken' ? 'Inspect the named import path and repair the shared-source load break.' : 'No action; the previously reported break cleared.'}\n`
    + `${details}\n`;
}

export async function watchLoadSentinel({ repoDir, signal, post, onResult, graphs }) {
  const sentinel = createLoadSentinel({ repoDir, signal, post, onResult, graphs });
  let debounce;
  let failure;
  const stopped = Promise.withResolvers();
  const observer = createFileChangeObserver(['apps', 'packages'].map(dir => join(repoDir, dir)), {
    recursive: true, persistent: true, isRelevant: (_directory, filename) => isSentinelSource(filename),
    onError: error => { failure = error; stopped.resolve(); },
  });
  const abort = () => stopped.resolve();
  const request = () => sentinel.request().catch(error => { failure = error; stopped.resolve(); });
  signal.addEventListener('abort', abort, { once: true });
  observer.subscribe(() => {
    clearTimeout(debounce);
    debounce = setTimeout(request, DEFAULT_FILE_CHANGE_CATCH_UP_MS);
  });
  try {
    if (!signal.aborted) { await request(); await stopped.promise; }
  } finally {
    clearTimeout(debounce);
    observer.close();
    signal.removeEventListener('abort', abort);
    await sentinel.idle();
  }
  if (failure && !signal.aborted) throw failure;
}
