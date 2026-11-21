import { randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readJsonIfExists, writeJsonAtomic } from '../../utils/fs/json.mjs';
import { withJsonOwnerFileLock } from '../../utils/proc/jsonOwnerFileLock.mjs';
import { isPidAlive, observePidLiveness } from '../../utils/proc/pids.mjs';
import { resolveDependencyInstallRoot, waitForDependencyRefreshWriter } from '../../utils/proc/dependency_refresh.mjs';
import { getRepoDir } from '../../utils/paths/paths.mjs';

const pendingPreparationPhases = new Set(['preparing', 'queued', 'building', 'prepared', 'checking']);
const preparationPhases = new Set([...pendingPreparationPhases, 'failed']);
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
  const targetPhases = Object.entries(current.targets ?? {})
    .map(([target, value]) => [target, readSourcePreparationPhase(value)]).filter(([, value]) => value);
  const targets = Object.fromEntries(targetPhases.filter(([, value]) => pendingPreparationPhases.has(value.phase)));
  // A controller's component-free initial phase is an aggregate once workers
  // report. Failed workers retain their request/watcher, not active work.
  const localPending = pendingPreparationPhases.has(phase.phase)
    && (phase.phase !== 'preparing' || phase.component != null || targetPhases.length === 0);
  const participating = [...targetPhases.map(([, value]) => value),
    ...(localPending || phase.phase === 'failed' ? [phase] : [])];
  if (participating.some(value => value.phase === 'failed')
    && !participating.some(value => pendingPreparationPhases.has(value.phase) && value.phase !== 'prepared')) return null;
  if (!localPending && Object.keys(targets).length === 0) return null;
  return { ...(localPending ? phase : { phase: 'preparing' }), ...(Object.keys(targets).length ? { targets } : {}) };
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
    if (target) {
      await writeJsonAtomic(markerPath, { ...current, targets: { ...current.targets, [target]: preparation } });
    } else if (component) {
      // Parallel producers share this request. Completed immutable output is
      // not ongoing work when a sibling is waiting on failed source inputs.
      const components = { ...current.components, [component]: preparation };
      const phases = Object.values(components).map(readSourcePreparationPhase).filter(Boolean);
      const active = phases.filter(value => value.phase !== 'prepared' && value.phase !== 'failed');
      const aggregate = active.find(value => value.component === component) ?? active.at(-1)
        ?? phases.find(value => value.phase === 'failed') ?? preparation;
      await writeJsonAtomic(markerPath, { ...current, components, component: null, ...aggregate });
    } else {
      await writeJsonAtomic(markerPath, { ...current, components: {}, component: null, ...preparation });
    }
  }, { lockPath: `${markerPath}.lock`, signal });
}

/** A reload's activation selected replacement bytes its Stack has not launched
 * yet: a `--restart` stops the incumbent first, and on an execution host the
 * selecting worker has exited by then. The request stays as this pid-less
 * marker until the next start takes it over or a terminal stop clears it, so
 * retention keeps the selection pinned in between (owner ruling 2026-11-15). */
export function pendingSourceSelectionAwaitsActivation(marker) {
  return marker?.phase === 'selected';
}

/** A terminal stop revokes the request before cleanup. The pending owner
 * observes the removal and aborts its preparation and waits. */
export async function releasePendingSourceSelection({ stackBaseDir }) {
  const markerPath = join(stackBaseDir, 'source-runtime/start.pending.json');
  const observed = await readJsonIfExists(markerPath);
  if (!observed) return;
  await withJsonOwnerFileLock(async () => {
    const current = await readJsonIfExists(markerPath);
    if (current && current.requestId === observed.requestId) await unlink(markerPath);
  }, { lockPath: `${markerPath}.lock` });
}

function activationInProgressError(pid) {
  return Object.assign(new Error(`[reload] the previous reload's replacement is still activating (pid=${pid ?? 'unknown'}); `
    + 'its incumbent is already retired, so this preparation leaves it running. Retry once it settles, or stop the Stack.'),
  { code: 'ESOURCEACTIVATIONINPROGRESS', pid: pid ?? null });
}

export function supersededError(message = 'Source Stack start superseded by a newer start for this stack') {
  const error = new Error(message);
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
 * `activation`: this start launches a reload's already-selected replacement after
 * its restart owner retired the incumbent, so it is the Stack's runtime. A newer
 * preparation is refused while it lives; only a newer activation replaces it.
 */
export async function beginPendingSourceStart({ stackBaseDir, onPhase, requestId: inheritedRequestId, replacePending = !inheritedRequestId,
  activation = false, env = process.env, repoDir = getRepoDir(fileURLToPath(new URL('../../../../../', import.meta.url)), env) }) {
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
    if (!activation && !sameRequest && current?.activation === true && ownerStatus !== 'dead') {
      throw activationInProgressError(current.pid);
    }
    // A dead worker's retry takes custody of the same request and its pins.
    await writeJsonAtomic(markerPath, { ...(sameRequest ? current : {}), requestId, pid: process.pid, phase: 'preparing',
      ...(activation ? { activation: true } : {}) });
    ownsMarker = true;
  }, { lockPath });
  let closed = false;
  let backgroundController;
  const backgroundPreparations = new Set();
  let lastPhase;
  const checkCurrent = async () => {
    if (closed || controller.signal.aborted) return;
    const current = await readJsonIfExists(markerPath);
    if (!closed && current?.requestId !== requestId) {
      controller.abort(supersededError(current ? undefined : 'Source Stack start cancelled because its request was released'));
    }
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
    // A reload selection hands this request to the Stack's next start.
    async publishSelection(fn) {
      return await publishCurrent(async () => {
        const result = await fn();
        close();
        await writeJsonAtomic(markerPath, { requestId, phase: 'selected' });
        ownsMarker = false;
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
