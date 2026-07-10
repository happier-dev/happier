import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { prepareRuntimeEntrypoint } from './_prepareRuntimeEntrypoint.mjs';
import {
  resolveValidRuntimeEntrypoint,
  resolveValidRuntimeSnapshot,
} from './_resolveRuntimeEntrypoint.mjs';

function isModuleResolutionFailure(error) {
  return error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'MODULE_NOT_FOUND';
}

function runtimeImportSpecifier(entrypoint, attempt) {
  const url = pathToFileURL(entrypoint);
  if (attempt > 0) url.searchParams.set('happier_runtime_retry', String(attempt));
  return url.href;
}

function manifestGeneration(snapshot) {
  const fingerprint = String(snapshot?.manifest?.fingerprint ?? '').trim().toLowerCase();
  const builtAt = String(snapshot?.manifest?.builtAt ?? '').trim();
  return `${fingerprint}\0${builtAt}`;
}

function errorTargetsEntrypoint(error, entrypoint) {
  try {
    return resolve(fileURLToPath(String(error?.url ?? ''))) === resolve(entrypoint);
  } catch {
    return false;
  }
}

async function waitForValidRuntimeEntrypoint(projectRoot, relativePath, opts) {
  const retryPollAttempts = Math.max(1, Number(opts.retryPollAttempts ?? 20));
  const retryDelayMs = Math.max(0, Number(opts.retryDelayMs ?? 5));
  for (let attempt = 0; attempt < retryPollAttempts; attempt += 1) {
    const entrypoint = resolveValidRuntimeEntrypoint(projectRoot, relativePath);
    if (entrypoint) return entrypoint;
    if (retryDelayMs > 0) await delay(retryDelayMs);
  }
  return null;
}

export async function importPreparedRuntimeEntrypoint(projectRoot, relativePath, opts = {}) {
  const importModule = opts.importModule ?? ((specifier) => import(specifier));
  const entrypoint = await prepareRuntimeEntrypoint(projectRoot, relativePath, opts);
  const selectedSnapshot = resolveValidRuntimeSnapshot(projectRoot, relativePath);
  const selectedEntrypointExisted = existsSync(entrypoint);

  try {
    return await importModule(runtimeImportSpecifier(entrypoint, 0));
  } catch (error) {
    if (!isModuleResolutionFailure(error)) throw error;

    const currentSnapshot = resolveValidRuntimeSnapshot(projectRoot, relativePath);
    const snapshotChanged = selectedSnapshot
      ? !currentSnapshot
        || currentSnapshot.entrypoint !== selectedSnapshot.entrypoint
        || manifestGeneration(currentSnapshot) !== manifestGeneration(selectedSnapshot)
      : Boolean(currentSnapshot);
    const swapObserved = snapshotChanged
      || !selectedEntrypointExisted
      || errorTargetsEntrypoint(error, entrypoint);
    if (!swapObserved) throw error;

    const replacementEntrypoint = currentSnapshot?.entrypoint
      ?? await waitForValidRuntimeEntrypoint(projectRoot, relativePath, opts);
    if (!replacementEntrypoint) throw error;

    return await importModule(runtimeImportSpecifier(replacementEntrypoint, 1));
  }
}

export async function runPreparedRuntimeEntrypointFromArgv(argv = process.argv) {
  const wrapperPath = String(argv[2] ?? '').trim();
  const projectRoot = String(argv[3] ?? '').trim();
  const relativePath = String(argv[4] ?? '').trim();
  if (!wrapperPath || !projectRoot || !relativePath) {
    throw new Error('Runtime importer requires wrapper path, project root, and relative entrypoint arguments');
  }

  const runtimeArgs = argv.slice(5);
  process.argv.splice(1, process.argv.length - 1, wrapperPath, ...runtimeArgs);
  return await importPreparedRuntimeEntrypoint(projectRoot, relativePath);
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  return Boolean(argv1) && resolve(argv1) === resolve(fileURLToPath(import.meta.url));
})();

if (invokedAsMain) {
  try {
    await runPreparedRuntimeEntrypointFromArgv();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
