import { stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { describeRuntimeImportFailure } from '../utils/proc/runtimeImportProbe.mjs';
import { readSourceReloadRefusal } from '../runtime/shared/source_reload_refusal.mjs';
import { isTerminalBuildFailure } from '../../../../scripts/workspaces/buildInputConvergence.mjs';

const failedCaptures = new WeakMap();

// This context stays inside the admitted producer, never on the worker wire.
export function rememberSourceCaptureFailure(error, captured) {
  if (error && typeof error === 'object') failedCaptures.set(error, captured);
  return error;
}

/** One trailing capture for an identified source edit; the second error wins. */
export async function withSourceCaptureRetry({ repoDir, env, signal, beforeRetry }, run) {
  try { return await run(); }
  catch (error) {
    const captured = failedCaptures.get(error);
    if (!captured || signal?.aborted || error.signal || error.name === 'AbortError'
      || error.code === 'BUILD_INPUTS_CHANGED' || isTerminalBuildFailure(error)) throw error;
    const diagnostic = error.diagnostic ?? error.stderr ?? error.message ?? '';
    const { firstFailingModule: file } = readSourceReloadRefusal({ firstFailingModule:
      error.firstFailingModule ?? error.errors?.find(item => item.location?.file)?.location.file
        ?? describeRuntimeImportFailure(String(diagnostic)).firstFailingModule }, env);
    if (!file) throw error;
    // Compiler locations are relative to the captured root or name either
    // absolute root. Membership keeps installed dependencies out of this rule.
    let path = isAbsolute(file) ? relative(captured.repoDir, file) : file;
    if (isAbsolute(file) && (path === '..' || path.startsWith(`..${sep}`))) path = relative(repoDir, file);
    path = path.split(sep).join('/');
    if (!captured.files.includes(path)) throw error;
    // An unavailable mtime cannot justify recovery or replace the original refusal.
    const info = await stat(resolve(repoDir, path)).catch(() => null);
    if (!info || !(info.mtimeMs > Date.parse(captured.capturedAt))) throw error;
    console.error(`[source-capture] retry file=${JSON.stringify(path)} capturedAt=${captured.capturedAt} fileMtime=${info.mtime.toISOString()}`);
    await beforeRetry?.();
    return await run();
  }
}
