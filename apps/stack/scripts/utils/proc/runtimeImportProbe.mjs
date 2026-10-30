import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const privateLine = /:\/\/|bearer |token|secret|password|api_?key|credential|database_url|-----begin|private_key|[A-Za-z0-9+/_=-]{40,}\.[A-Za-z0-9+/_=-]{20,}/i;

export function describeRuntimeImportFailure(stderr, entrypoint = null) {
  // Node's first location names the throwing module, including TDZ failures;
  // bundlers/Vite also publish file:line locations before their stack frames.
  const frames = stderr.split('\n').filter(line => !/\bnode:/u.test(line)).join('\n');
  const error = stderr.match(/(?:^|\n)([A-Za-z]*Error)(?: \[([^\]]+)\])?: ([^\n]*)/u);
  const moduleLocation = /(?:file:\/\/\/|[A-Za-z]:[\\/]|\/|(?:\.{1,2}\/)*(?:apps|packages|scripts)\/)[^\s()'"<>]+?:\d+(?::\d+)?/u;
  // A loader can print its own code frame before naming the authored parse
  // error. Its explicit error location is stronger than that wrapper frame.
  const location = error?.[3]?.match(moduleLocation)?.[0]
    ?? frames.match(/evalmachine\.<anonymous>:\d+(?::\d+)?/u)?.[0]
    ?? frames.match(moduleLocation)?.[0];
  const importer = error?.[3]?.match(/\bimported from ((?:file:\/\/\/|[A-Za-z]:[\\/]|\/).+)$/u)?.[1];
  const file = importer ?? location?.replace(/:\d+(?::\d+)?$/u, '');
  const firstFailingModule = file?.startsWith('file:') ? fileURLToPath(file) : file ?? entrypoint;
  const visible = stderr.split('\n').filter(line => !privateLine.test(line)).join('\n').trim();
  const message = error?.[3] && !privateLine.test(error[3]) ? error[3] : visible || 'Entry process failed without public loader diagnostics';
  return {
    firstFailingModule: privateLine.test(firstFailingModule) ? entrypoint : firstFailingModule,
    loadError: { name: error?.[1] ?? 'Error', code: error?.[2] ?? null, message },
  };
}

/**
 * Fresh native child shared by CLI integrity and the composed entry-load check.
 * Callers own their arguments, isolation and any existing lifecycle deadline.
 * @returns {Promise<{status: 'passed'|'failed', elapsedMs: number, exitCode: number|null,
 * signal: string|null, firstFailingModule: string|null,
 * loadError: {name: string, code: string|null, message: string}|null}>}
 */
export async function probeRuntimeImport({ entrypoint, args = [], nodeArgs = [],
  nodeExecutable = process.execPath, cwd, env = process.env, signal, timeoutMs }) {
  const started = performance.now();
  return await new Promise((resolve, reject) => {
    const child = spawn(nodeExecutable, [...nodeArgs, entrypoint, ...args], {
      cwd, env, signal, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    let timedOut = false;
    let spawnError = null;
    const timeout = timeoutMs === undefined ? null : setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timeout?.unref?.();
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.once('error', error => { spawnError = signal?.aborted ? signal.reason ?? error : error; });
    child.once('close', (exitCode, exitSignal) => {
      if (timeout !== null) clearTimeout(timeout);
      if (signal?.aborted) { reject(signal.reason ?? spawnError); return; }
      const failed = timedOut || spawnError !== null || exitCode !== 0;
      const diagnostic = failed ? describeRuntimeImportFailure(stderr, entrypoint) : { firstFailingModule: null, loadError: null };
      if (timedOut) diagnostic.loadError = { name: 'TimeoutError', code: 'import_timeout', message: `Runtime import timed out after ${timeoutMs}ms` };
      else if (spawnError) diagnostic.loadError = { name: spawnError.name, code: spawnError.code ?? null,
        message: privateLine.test(spawnError.message) ? 'Entry process could not start' : spawnError.message };
      resolve({ status: failed ? 'failed' : 'passed', elapsedMs: performance.now() - started,
        exitCode, signal: exitSignal, ...diagnostic });
    });
  });
}
