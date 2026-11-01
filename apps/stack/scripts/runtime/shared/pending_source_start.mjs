import { randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFileChangeObserver, DEFAULT_FILE_CHANGE_CATCH_UP_MS } from '../../../../../packages/cli-common/fileChangeObserver.mjs';

import { readJsonIfExists, writeJsonAtomic } from '../../utils/fs/json.mjs';
import { readJsonOwnerLockRaw, withJsonOwnerFileLock } from '../../utils/proc/jsonOwnerFileLock.mjs';
import { createWorkspaceBuildWaitNotifier } from '../../utils/proc/workspaceBuildWaitNotifier.mjs';
import { isPidAlive, observePidLiveness } from '../../utils/proc/pids.mjs';
import { resolveDependencyInstallRoot, waitForDependencyRefreshWriter } from '../../utils/proc/dependency_refresh.mjs';
import { getRepoDir } from '../../utils/paths/paths.mjs';

const preparationPhases = new Set(['preparing', 'queued', 'building', 'prepared', 'checking']);
const phaseEventPrefix = 'HSTACK_SOURCE_PREPARATION_PHASE=';
export const SOURCE_START_SUPERSEDED_MARKER = 'HSTACK_SOURCE_START_SUPERSEDED';

/** Carry the canonical admission result over the existing worker stdout. */
export function emitSourceStartSuperseded(error, write = line => process.stdout.write(line)) {
  if (error?.code !== 'ESOURCESTARTSUPERSEDED' && error?.cause?.code !== 'ESOURCESTARTSUPERSEDED') return false;
  write(`${SOURCE_START_SUPERSEDED_MARKER}\n`);
  return true;
}

export function readSourcePreparationPhase(value) {
  if (!value || !preparationPhases.has(value.phase)) return null;
  if (value.component != null && !['server', 'daemon', 'ui'].includes(value.component)) return null;
  return { phase: value.phase, ...(value.component != null ? { component: value.component } : {}) };
}

/** Typed diagnostic on the existing worker stdout transport, not a log parser. */
export function parseSourcePreparationPhaseLine(line) {
  if (!line.startsWith(phaseEventPrefix)) return null;
  try { return readSourcePreparationPhase(JSON.parse(line.slice(phaseEventPrefix.length))); }
  catch { return null; }
}

export function emitSourcePreparationPhase(phase) {
  process.stdout.write(phaseEventPrefix + JSON.stringify(phase) + '\n');
}

export async function readPendingSourcePreparation({ stackBaseDir }) {
  const current = await readJsonIfExists(join(stackBaseDir, 'source-runtime/start.pending.json'));
  const phase = readSourcePreparationPhase(current);
  if (!phase || !isPidAlive(current.pid)) return null;
  const targets = Object.fromEntries(Object.entries(current.targets ?? {})
    .map(([target, value]) => [target, readSourcePreparationPhase(value)]).filter(([, value]) => value));
  return { ...phase, ...(Object.keys(targets).length ? { targets } : {}) };
}

/** Await existing readiness/failure cleanup without blocking the dependency
 * readers that this already-pending start still needs in order to finish. */
export async function waitForPendingSourcePreparation({ stackBaseDir, env = process.env, signal }) {
  const directory = join(stackBaseDir, 'source-runtime');
  const markerPath = join(directory, 'start.pending.json');
  const readSnapshot = () => readJsonOwnerLockRaw(markerPath);
  const observer = createFileChangeObserver([directory], {
    isRelevant: (_directory, filename) => filename == null || String(filename) === 'start.pending.json',
  });
  const onWait = createWorkspaceBuildWaitNotifier({ env,
    label: `Stack ${basename(stackBaseDir)} readiness before dependency refresh` });
  const startedAt = Date.now();
  try {
    for (;;) {
      signal?.throwIfAborted();
      const snapshot = observer.capture(readSnapshot);
      if (!await readPendingSourcePreparation({ stackBaseDir })) return;
      onWait({ waitedMs: Date.now() - startedAt });
      await observer.wait({ snapshot, readSnapshot, signal, maxWaitMs: DEFAULT_FILE_CHANGE_CATCH_UP_MS });
    }
  } finally {
    observer.close();
  }
}

/** The admitted producer updates only its caller's existing pending request. */
export async function updatePendingSourcePreparationPhase({ stackBaseDir, requestId, phase, component, target, signal }) {
  const preparation = readSourcePreparationPhase({ phase, component });
  if (!preparation) throw new Error('invalid source preparation phase');
  const markerPath = join(stackBaseDir, 'source-runtime/start.pending.json');
  await withJsonOwnerFileLock(async () => {
    signal?.throwIfAborted();
    const current = await readJsonIfExists(markerPath);
    if (current?.requestId !== requestId) throw supersededError();
    await writeJsonAtomic(markerPath, target
      ? { ...current, targets: { ...current.targets, [target]: preparation } }
      : { ...current, component: null, ...preparation });
  }, { lockPath: `${markerPath}.lock`, signal });
}

export function supersededError() {
  const error = new Error('Source Stack start superseded by a newer start for this stack');
  error.name = 'AbortError';
  error.code = 'ESOURCESTARTSUPERSEDED';
  return error;
}

/** The finite producer pins completed output before it releases build custody.
 * It consumes the same pending request as its Stack caller, never selects UI. */
export async function retainPendingSourcePreparation({ stackBaseDir, requestId, preparationDir, signal }) {
  const markerPath = join(stackBaseDir, 'source-runtime/start.pending.json');
  await withJsonOwnerFileLock(async () => {
    signal?.throwIfAborted();
    const current = await readJsonIfExists(markerPath);
    if (current?.requestId !== requestId) throw supersededError();
    const preparationDirs = [...new Set([...(current.preparationDirs ?? []), current.preparationDir, preparationDir].filter(Boolean))];
    // Already-loaded retainers may only understand the original singular
    // field. Keep its primary graph pinned while current readers retain all
    // preparations through the same pending request.
    await writeJsonAtomic(markerPath, { ...current, preparationDir: current.preparationDir ?? preparationDir, preparationDirs });
  }, { lockPath: `${markerPath}.lock`, signal });
}

/** Only pending source preparation is replaceable. Publication and replacement
 * share the existing file-lock primitive so an old start cannot publish after a
 * successor claims this stack. No process is signalled by this owner.
 */
export async function beginPendingSourceStart({ stackBaseDir, onPhase, requestId: inheritedRequestId, replacePending = !inheritedRequestId,
  env = process.env, repoDir = getRepoDir(fileURLToPath(new URL('../../../../../', import.meta.url)), env) }) {
  const directory = join(stackBaseDir, 'source-runtime');
  const markerPath = join(directory, 'start.pending.json');
  const lockPath = `${markerPath}.lock`;
  const requestId = inheritedRequestId ?? randomUUID();
  const controller = new AbortController();
  let ownsMarker = false;
  await mkdir(directory, { recursive: true });
  await waitForDependencyRefreshWriter({ installDir: resolveDependencyInstallRoot(repoDir), env });
  await withJsonOwnerFileLock(async () => {
    const current = await readJsonIfExists(markerPath);
    const sameRequest = inheritedRequestId && current?.requestId === requestId;
    const ownerStatus = current ? observePidLiveness(current.pid).status : 'dead';
    // A delegated half participates in the existing start; its publication and
    // cleanup must not replace or retire the parent's preparation custody.
    if (sameRequest && ownerStatus === 'alive') return;
    if (inheritedRequestId && current && !replacePending
      && ownerStatus !== 'dead') throw supersededError();
    // A dead worker's retry takes custody of the same request and its pins.
    await writeJsonAtomic(markerPath, { ...(sameRequest ? current : {}), requestId, pid: process.pid, phase: 'preparing' });
    ownsMarker = true;
  }, { lockPath });
  let closed = false;
  let backgroundController;
  const backgroundPreparations = new Set();
  let lastPhase;
  const checkCurrent = async () => {
    if (closed || controller.signal.aborted) return;
    const current = await readJsonIfExists(markerPath);
    if (!closed && current?.requestId !== requestId) controller.abort(supersededError());
    if (!closed && current?.requestId === requestId && onPhase) {
      const phase = readSourcePreparationPhase(current);
      const serialized = JSON.stringify(phase);
      if (phase && serialized !== lastPhase) { lastPhase = serialized; onPhase(phase); }
    }
  };
  const watcher = watch(directory, { persistent: false }, () => {
    void checkCurrent().catch(error => controller.abort(error));
  });
  watcher.on('error', error => controller.abort(error));
  const close = () => { closed = true; watcher.close(); };
  await checkCurrent();
  const removeOwnMarker = async () => {
    if (ownsMarker && (await readJsonIfExists(markerPath))?.requestId === requestId) await unlink(markerPath);
  };
  const publishCurrent = async fn => await withJsonOwnerFileLock(async () => {
    controller.signal.throwIfAborted();
    if ((await readJsonIfExists(markerPath))?.requestId !== requestId) {
      controller.abort(supersededError());
      controller.signal.throwIfAborted();
    }
    return await fn();
  }, { lockPath, signal: controller.signal });
  return {
    requestId,
    signal: controller.signal,
    async setPhase(phase, target) {
      await updatePendingSourcePreparationPhase({ stackBaseDir, requestId, ...phase, target, signal: controller.signal });
      await checkCurrent();
    },
    async retainPreparation(preparationDir) {
      await retainPendingSourcePreparation({ stackBaseDir, requestId, preparationDir, signal: controller.signal });
    },
    abort(reason) { controller.abort(reason); },
    prepareInBackground(prepare) {
      backgroundController ??= new AbortController();
      const signal = AbortSignal.any([controller.signal, backgroundController.signal]);
      const task = Promise.resolve().then(() => prepare(signal));
      backgroundPreparations.add(task);
      task.then(() => backgroundPreparations.delete(task), () => backgroundPreparations.delete(task));
      return task;
    },
    // A completed serving path may be admitted before the rest of startup.
    // Keep the same request and its retained preparations until final publish.
    publishPreparation: publishCurrent,
    async publish(fn) {
      return await publishCurrent(async () => {
        const result = await fn();
        close();
        await removeOwnMarker();
        return result;
      });
    },
    async dispose() {
      backgroundController?.abort();
      await Promise.allSettled([...backgroundPreparations]);
      close();
      await withJsonOwnerFileLock(removeOwnMarker, { lockPath });
    },
  };
}
