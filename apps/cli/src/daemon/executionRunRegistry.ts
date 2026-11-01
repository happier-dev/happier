import { configuration } from '../configuration';
import { logger } from '../ui/logger';
import { createHash, randomUUID } from 'node:crypto';
import { statSync, watch, type FSWatcher } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { DaemonExecutionRunMarkerPersistenceReadSchema, DaemonExecutionRunMarkerOwnerWriteSchema, DaemonExecutionRunMarkerSchema } from '@happier-dev/protocol/daemon/executionRuns';
import type { DaemonExecutionRunMarker, DaemonExecutionRunMarkerPersistenceRead, DaemonExecutionRunMarkerOwnerWrite } from '@happier-dev/protocol';
import { WorkerUpdateV1Schema } from '@happier-dev/protocol/sessions/relations/workerUpdateV1';
import { FollowPolicyV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { z } from 'zod/mini';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { readOrCreateDeviceLocalSecretStorage, type DeviceLocalSecretStorage } from './deviceLocalSecretStorage';
import { resolveReleaseRingScopedBasename } from '../cli/runtime/publicReleaseChannel';
import {
  publishProtectedLocalStateFileIfAbsent,
  readProtectedLocalStateFile,
  removeProtectedLocalStateFile,
  writeProtectedLocalStateFileAtomic,
} from '../utils/fs/protectedLocalState';
import { isPidPresent } from '@happier-dev/cli-common/process';
import { processGenerationProvesReuse, readProcessIdentityByPid } from './processIdentity';
import {
  RetainedExecutionRunRecordSchema, projectRetainedExecutionRunState, projectExecutionRunHostLoss,
  type RetainedExecutionRunRecord,
} from '@/agent/runtime/bridges/executionRun/retainedState';
import type { ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';
import { composeExecutionRunWorkerUpdate } from '@/agent/runtime/bridges/executionRun/executionRunWorkerUpdate';
import type { LiveWorkItemV1, LiveWorkProducerV1 } from './lifecycle/managedActivity';
import { resolveExecutionRunLifecycle } from '@/agent/runtime/bridges/executionRun/resolveExecutionRunLifecycle';
import { projectExecutionRunPublicState } from '@/agent/runtime/bridges/executionRun/publicState';
import { RequesterWorkAttributionV1Schema, type RequesterWorkAttributionV1 } from './lifecycle/requesterWorkAttribution';
import { notifyDaemonSessionActivityChanged } from './controlClient';
import { resolveExecutionRunFollowOccurrenceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';

const liveWorkListeners = new Set<() => void>();
function notifyExecutionRunLiveWorkChanged(): void {
  for (const listener of liveWorkListeners) {
    try { listener(); } catch { /* Observation cannot alter retained execution custody. */ }
  }
}

/**
 * Reads the existing lifecycle records, visibility markers and retained delivery
 * custody. A demand-owned directory watcher also observes Session process writes.
 * Native watcher failure and incomplete parsing cannot establish inactivity.
 */
export function createExecutionRunLiveWorkProducer(): LiveWorkProducerV1 {
  const listeners = new Set<() => void>();
  let watcher: FSWatcher | undefined;
  let watchedDirectory: string | undefined;
  let watchedIdentity: Readonly<{ dev: number; ino: number }> | undefined;
  let watcherFailed = false;
  const notify = () => {
    for (const listener of listeners) {
      try { listener(); } catch { /* Observation cannot alter execution custody. */ }
    }
  };
  const closeWatcher = () => {
    const current = watcher;
    watcher = undefined;
    watchedDirectory = undefined;
    watchedIdentity = undefined;
    current?.close();
  };
  const armWatcher = () => {
    const directory = resolveExecutionRunMarkerDir();
    if (watcher && watchedDirectory !== directory) { closeWatcher(); watcherFailed = false; }
    if (!listeners.size || watcher || watcherFailed) return;
    try {
      const identity = statSync(directory);
      const armed = watch(directory, { persistent: false }, notify);
      watcher = armed;
      watchedDirectory = directory;
      watchedIdentity = { dev: identity.dev, ino: identity.ino };
      const unavailable = () => {
        if (watcher !== armed) return;
        watcherFailed = true;
        closeWatcher();
        notify();
      };
      armed.on('error', unavailable);
      armed.on('close', unavailable);
    } catch (error) {
      // An absent directory can be established by the incumbent marker owner
      // before a later read. Other native failures need subscription repair.
      watcherFailed = (error as NodeJS.ErrnoException)?.code !== 'ENOENT';
    }
  };
  return {
    async read() {
      armWatcher();
      const observedWatcher = watcher;
      const observedIdentity = watchedIdentity;
      let coverage: 'complete' | 'unknown' = observedWatcher ? 'complete' : 'unknown';
      const incomplete = () => { coverage = 'unknown'; };
      const observations = await Promise.allSettled([
        listExecutionRunMarkersRaw(incomplete), readRetainedExecutionRunRecords(incomplete), readPendingExecutionRunWorkerUpdates(incomplete),
      ]);
      const items = new Map<string, LiveWorkItemV1>();
      const put = (runId: string, state: LiveWorkItemV1['state'], attribution?: RequesterWorkAttributionV1) => {
        const prior = items.get(runId);
        if (prior?.state === 'active' && state !== 'active') return;
        const compatible = !prior || prior.state !== 'active' || state !== 'active'
          || attribution && !('kind' in prior.attribution)
            && attribution.serverId === prior.attribution.serverId && attribution.accountId === prior.attribution.accountId
            && attribution.machineId === prior.attribution.machineId && attribution.installationId === prior.attribution.installationId;
        items.set(runId, { category: 'execution_run', ownerRef: runId,
          attribution: compatible && attribution ? attribution : { kind: 'unknown' }, state });
      };
      const [markers, retained, deliveries] = observations;
      if (markers.status === 'fulfilled') for (const marker of markers.value) {
        put(marker.runId, isRunningMarker(marker) || marker.executionRunConnectedServicesCleanupReceiptV1 ? 'active' : 'settled', marker.requesterWorkAttributionV1);
      }
      if (retained.status === 'fulfilled') for (const record of retained.value) {
        put(record.state.runId, record.state.status === 'running' || record.terminalEventId ? 'active' : 'settled', record.requesterWorkAttributionV1);
      }
      if (deliveries.status === 'fulfilled') for (const delivery of deliveries.value) put(delivery.update.workerId, 'active', delivery.requesterWorkAttributionV1);
      if (observedWatcher && watcher === observedWatcher) {
        try {
          const currentIdentity = await stat(resolveExecutionRunMarkerDir());
          if (currentIdentity.dev !== observedIdentity?.dev || currentIdentity.ino !== observedIdentity?.ino) {
            closeWatcher();
            armWatcher();
            notify();
          }
        } catch { closeWatcher(); notify(); }
      }
      if (observations.some(result => result.status === 'rejected') || !watcher || watcher !== observedWatcher) coverage = 'unknown';
      // The incumbent marker read can establish a previously absent directory.
      // Arm its edge source and notify the aggregate to take a covered snapshot;
      // this first uncovered snapshot itself must still remain unknown.
      if (!observedWatcher && !watcherFailed && listeners.size) {
        armWatcher();
        if (watcher) notify();
      }
      return { items: [...items.values()], coverage };
    },
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        watcherFailed = false;
        liveWorkListeners.add(notify);
      }
      armWatcher();
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          liveWorkListeners.delete(notify);
          closeWatcher();
        }
      };
    },
  };
}

function retainedStatePath(runId: string): string {
  return join(resolveExecutionRunMarkerDir(), `state-${digestEntryIdentity([runId])}.sealed`);
}

function priorRetainedStatePath(runId: string): string {
  return join(resolveExecutionRunMarkerDir(), `state-${Buffer.from(runId).toString('base64url')}.sealed`);
}

/** The previous development writer used identity-encoded basenames. Keep one
 * current copy before retiring that name; an existing current copy always wins. */
async function adoptPriorRetainedEntry<T>(input: Readonly<{
  runId: string; path: string; currentPath: string; validatePrior: (ciphertext: string) => void; readCurrent: () => Promise<T>;
}>): Promise<T> {
  return serializeRetainedStateWrite(input.runId, async () => {
    // A prior adopter/ACK may have retired both names while this scan waited.
    let ciphertext: string;
    try { ciphertext = await readProtectedLocalStateFile(input.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return input.readCurrent();
      throw error;
    }
    input.validatePrior(ciphertext);
    await publishProtectedLocalStateFileIfAbsent(input.currentPath, ciphertext, { authority: 'owned' });
    const current = await input.readCurrent();
    try { await removeProtectedLocalStateFile(input.path); }
    catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error; }
    return current;
  });
}

// Only failed observations are retained. File/key/permission changes retry the
// real reader; unchanged failures remain unknown without reopening/decrypting.
const unavailableRetainedEntries = new Map<string, Readonly<{ observation: string | null }>>();

function pruneUnavailableRetainedEntries(prefix: string, entries: readonly string[]): void {
  const directory = resolveExecutionRunMarkerDir();
  const present = new Set(entries.map(entry => join(resolveExecutionRunMarkerDir(), entry)));
  for (const path of unavailableRetainedEntries.keys()) {
    if (dirname(path) !== directory || basename(path).startsWith(prefix) && !present.has(path)) {
      unavailableRetainedEntries.delete(path);
    }
  }
}

function retainedEntryStatIdentity(value: Awaited<ReturnType<typeof lstat>>): string {
  return [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs, value.mode, value.uid].join(':');
}

async function retainedEntryObservation(path: string): Promise<string | null> {
  try {
    const [entry, key, directory] = await Promise.all([
      lstat(path), lstat(configuration.deviceLocalSecretKeyFile), lstat(resolveExecutionRunMarkerDir()),
    ]);
    return `${retainedEntryStatIdentity(entry)}|${retainedEntryStatIdentity(key)}|${directory.dev}:${directory.ino}:${directory.mode}:${directory.uid}`;
  } catch { return null; }
}

function reportUnavailableRetainedEntry(path: string, observation: string | null,
  diagnostic: Readonly<{ code: string; entry: string; reason?: string }>, message: string): void {
  const reported = unavailableRetainedEntries.has(path);
  unavailableRetainedEntries.set(path, { observation });
  if (!reported) logger.warn(message, diagnostic);
}

// Serialization belongs to this file's existing persistence owner, including
// provider-acceptance ACK writes. It does not decide Run/controller lifecycle.
const retainedStateWrites = new Map<string, Promise<void>>();
function serializeRetainedStateWrite<T>(runId: string, write: () => Promise<T>): Promise<T> {
  const path = retainedStatePath(runId);
  const previous = retainedStateWrites.get(path) ?? Promise.resolve();
  const next = previous.then(write, write);
  const tracked = next.then(() => {}, () => {}).finally(() => {
    if (retainedStateWrites.get(path) === tracked) retainedStateWrites.delete(path);
  });
  retainedStateWrites.set(path, tracked);
  return next;
}

export async function readRetainedExecutionRunRecord(runId: string): Promise<RetainedExecutionRunRecord | null> {
  const storage = await readOrCreateDeviceLocalSecretStorage({ path: configuration.deviceLocalSecretKeyFile });
  const path = retainedStatePath(runId);
  try {
    const record = createStoredReadSchema(RetainedExecutionRunRecordSchema).parse(storage.openJson({
      purpose: 'execution_run_state', ciphertext: await readProtectedLocalStateFile(path),
    }));
    if (record.state.runId !== runId) throw new Error('Retained execution state identity mismatch');
    return record;
  } catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error; }
  const priorPath = priorRetainedStatePath(runId);
  let ciphertext: string;
  try { ciphertext = await readProtectedLocalStateFile(priorPath); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    // An absent or unrepresentable former basename needs no inventory scan.
    if (code === 'ENOENT' || code === 'ENAMETOOLONG') return null;
    throw error;
  }
  const prior = createStoredReadSchema(RetainedExecutionRunRecordSchema).parse(storage.openJson({ purpose: 'execution_run_state', ciphertext }));
  if (prior.state.runId !== runId) throw new Error('Retained execution state identity mismatch');
  return prior;
}

async function writeRetainedExecutionRunRecord(record: RetainedExecutionRunRecord, attentionChanged = false): Promise<void> {
  const storage = await readOrCreateDeviceLocalSecretStorage({ path: configuration.deviceLocalSecretKeyFile });
  await writeProtectedLocalStateFileAtomic(retainedStatePath(record.state.runId), storage.sealJson({
    purpose: 'execution_run_state', value: RetainedExecutionRunRecordSchema.parse(record),
  }), { authority: 'owned' });
  notifyExecutionRunLiveWorkChanged();
  const state = record.state;
  if (state.sessionId && (state.terminalOccurrenceId || attentionChanged)) {
    // A hint never owns delivery or terminal state. Read-after-write routing
    // re-enters the retained original, current Follow and Pending owners.
    const occurrence = resolveExecutionRunFollowOccurrenceV1({ ...state, sessionId: state.sessionId,
      terminalEventId: state.terminalOccurrenceId ?? null });
    // Empty attention re-enters the same source range read, withdrawing an
    // outstanding original without inventing a terminal event or another log.
    void notifyDaemonSessionActivityChanged(state.sessionId, occurrence ?? undefined)
      .catch(error => logger.debug('[executionRunRegistry] Follow occurrence remains in retained Run custody', error));
  }
}

async function acknowledgeRetainedRunTerminal(input: RetainedExecutionRunWorkerUpdate): Promise<void> {
  const record = await readRetainedExecutionRunRecord(input.update.workerId);
  if (!record) return;
  if (record.terminalEventId && input.localId === `execution-run-worker-update:${record.terminalEventId}`) {
    const { terminalEventId: _accepted, ...accepted } = record;
    await writeRetainedExecutionRunRecord(accepted);
  }
}

export async function retainExecutionRunState(state: ExecutionRunState, terminalEventId?: string, requesterWorkAttributionV1?: RequesterWorkAttributionV1): Promise<void> {
  const identity = await readProcessIdentityByPid(process.pid);
  await serializeRetainedStateWrite(state.runId, async () => {
    const current = await readRetainedExecutionRunRecord(state.runId);
    const attribution = requesterWorkAttributionV1 ?? state.requesterWorkAttributionV1 ?? current?.requesterWorkAttributionV1;
    const pendingEventId = terminalEventId ?? (state.status !== 'running'
      && current?.state.finishedAtMs === state.finishedAtMs ? current?.terminalEventId : undefined);
    await writeRetainedExecutionRunRecord({
      ownerPid: process.pid,
      ...(attribution ? { requesterWorkAttributionV1: RequesterWorkAttributionV1Schema.parse(attribution) } : {}),
      ...(identity?.processStartTimeMs !== undefined ? { ownerProcessStartTimeMs: identity.processStartTimeMs } : {}),
      state: projectRetainedExecutionRunState(state), ...(pendingEventId ? { terminalEventId: pendingEventId } : {}),
    }, JSON.stringify(current?.state.attention?.requests ?? []) !== JSON.stringify(state.attention?.requests ?? []));
  });
}

export async function readRetainedExecutionRunRecords(onUnavailable?: () => void): Promise<readonly RetainedExecutionRunRecord[]> {
  await Promise.all(retainedStateWrites.values());
  let entries: string[];
  try { entries = (await readdir(resolveExecutionRunMarkerDir())).filter((entry) => entry.startsWith('state-') && entry.endsWith('.sealed')); }
  catch (error) { if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') { pruneUnavailableRetainedEntries('state-', []); return []; } throw error; }
  pruneUnavailableRetainedEntries('state-', entries);
  if (!entries.length) return [];
  const storage = await readOrCreateDeviceLocalSecretStorage({ path: configuration.deviceLocalSecretKeyFile });
  const records = new Map<string, RetainedExecutionRunRecord>();
  for (const entry of entries) {
    const path = join(resolveExecutionRunMarkerDir(), entry);
    const observation = await retainedEntryObservation(path);
    if (unavailableRetainedEntries.has(path) && unavailableRetainedEntries.get(path)?.observation === observation) {
      onUnavailable?.();
      continue;
    }
    try {
      const ciphertext = await readProtectedLocalStateFile(path);
      const parsed = createStoredReadSchema(RetainedExecutionRunRecordSchema).safeParse(storage.openJson({
        purpose: 'execution_run_state', ciphertext,
      }));
      if (!parsed.success || retainedStatePath(parsed.data.state.runId) !== path && priorRetainedStatePath(parsed.data.state.runId) !== path) {
        onUnavailable?.();
        reportUnavailableRetainedEntry(path, observation, {
          code: 'execution_run_state_unavailable', entry,
          reason: parsed.success ? 'identity_mismatch' : 'invalid_record',
        }, '[executionRunRegistry] Retained execution state could not be opened');
        continue;
      }
      const currentPath = retainedStatePath(parsed.data.state.runId);
      const record = currentPath === path ? parsed.data : await adoptPriorRetainedEntry({ runId: parsed.data.state.runId, path, currentPath,
        validatePrior: value => {
          const prior = createStoredReadSchema(RetainedExecutionRunRecordSchema).parse(storage.openJson({ purpose: 'execution_run_state', ciphertext: value }));
          if (priorRetainedStatePath(prior.state.runId) !== path) throw new Error('Retained execution state identity mismatch');
        },
        readCurrent: async () => {
          const current = await readRetainedExecutionRunRecord(parsed.data.state.runId);
          if (!current) throw new Error('Retained execution state publication missing');
          return current;
        },
      });
      unavailableRetainedEntries.delete(path);
      records.set(record.state.runId, record);
    } catch (error) {
      // Terminal GC can retire ephemeral state after the directory scan.
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') { unavailableRetainedEntries.delete(path); continue; }
      onUnavailable?.();
      reportUnavailableRetainedEntry(path, observation, {
        code: 'execution_run_state_unavailable', entry, reason: 'read_failed',
      }, '[executionRunRegistry] Retained execution state could not be opened');
    }
  }
  return [...records.values()];
}

/** Home retention consumes the same live custody and native-resume facts as Run lifecycle. */
async function readExecutionRunHomeRetention() {
  let complete = true;
  const [markers, records] = await Promise.all([
    listExecutionRunMarkersRaw(() => { complete = false; }),
    readRetainedExecutionRunRecords(() => { complete = false; }),
  ]);
  const keys = new Set(markers.filter(isRunningMarker).map(marker => marker.runId));
  for (const { state } of records) {
    if (state.status === 'running' || resolveExecutionRunLifecycle(state, null).projection.state !== 'unavailable') {
      keys.add(state.runId);
    }
  }
  return { keys, complete };
}

function refuseIncompleteExecutionRunHomeRetention(): never {
  throw Object.assign(new Error('Execution Run home retention is unavailable'), {
    code: 'execution_run_home_retention_unavailable',
  });
}

export async function readRetainedExecutionRunHomeKeys(): Promise<readonly string[]> {
  const { keys, complete } = await readExecutionRunHomeRetention();
  if (!complete) refuseIncompleteExecutionRunHomeRetention();
  return [...keys];
}

export async function isExecutionRunHomeRetained(runId: string): Promise<boolean> {
  const { keys, complete } = await readExecutionRunHomeRetention();
  // Positive custody proves retention even if an unrelated record is unreadable.
  // Only absence needs a complete census before a home may be removed.
  if (keys.has(runId)) return true;
  if (!complete) refuseIncompleteExecutionRunHomeRetention();
  return false;
}

/** Existing daemon process supervision feeds the lifecycle owner; transport loss never does. */
export async function reconcileRetainedExecutionRunRecords(params: Readonly<{
  nowMs: number;
  isPidAlive?: (pid: number) => boolean | Promise<boolean>;
  isPidSafeHappyProcess?: (pid: number) => boolean | Promise<boolean>;
}>, onUnavailable?: () => void): Promise<readonly RetainedExecutionRunRecord[]> {
  const records = await readRetainedExecutionRunRecords(onUnavailable);
  const reconciled: RetainedExecutionRunRecord[] = [];
  for (const observed of records) {
    const reconciledRecord = await serializeRetainedStateWrite(observed.state.runId, async () => {
      // A checkpoint or acceptance ACK may have advanced the scanned record.
      const record = await readRetainedExecutionRunRecord(observed.state.runId);
      if (!record) return null;
      let next = record;
      if (record.state.status === 'running') {
        const alive = await (params.isPidAlive ?? isPidPresent)(record.ownerPid);
        // Process recognition can be inconclusive. Its visibility-only boolean
        // is not authority to settle a live owner's lifecycle or admit resume.
        const identity = alive && record.ownerProcessStartTimeMs !== undefined ? await readProcessIdentityByPid(record.ownerPid) : null;
        const reused = processGenerationProvesReuse(record.ownerProcessStartTimeMs, identity?.processStartTimeMs);
        if (!alive || reused) {
          next = projectExecutionRunHostLoss(record, params.nowMs);
          await writeRetainedExecutionRunRecord(next);
          const run = next.state;
          const { resolvedSelection } = projectExecutionRunPublicState(run);
          await writeExecutionRunMarker({
            pid: record.ownerPid, happySessionId: run.sessionId, runId: run.runId, callId: run.callId,
            ...(next.requesterWorkAttributionV1 ? { requesterWorkAttributionV1: next.requesterWorkAttributionV1 } : {}),
            sidechainId: run.sidechainId, intent: run.intent, backendTarget: readBackendTargetRefV2(run.backendTarget),
            permissionMode: run.permissionMode, retentionPolicy: run.retentionPolicy, runClass: run.runClass,
            ioMode: run.ioMode, status: run.status, startedAtMs: run.startedAtMs,
            ...(resolvedSelection ? { resolvedSelection } : {}),
            updatedAtMs: params.nowMs, finishedAtMs: params.nowMs, errorCode: 'execution_run_host_lost',
          });
        }
      }
      if (next.terminalEventId) {
        const update = composeExecutionRunWorkerUpdate(next.state, next.terminalEventId);
        if (update) {
          const path = join(resolveExecutionRunMarkerDir(), resolveWorkerUpdateEntry(update.update.workerId, update.localId));
          // An existing (even unreadable) delivery owns its immutable custody.
          // Recovery only fills the crash window before initial publication.
          try { await readProtectedLocalStateFile(path); }
          catch (error) {
            if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
            await retainExecutionRunWorkerUpdate({ ...update,
              ...(next.requesterWorkAttributionV1 ? { requesterWorkAttributionV1: next.requesterWorkAttributionV1 } : {}),
            });
          }
        } else {
          const { terminalEventId: _notSelected, ...settled } = next;
          next = settled;
          await writeRetainedExecutionRunRecord(next);
        }
      }
      return next;
    });
    if (reconciledRecord) reconciled.push(reconciledRecord);
  }
  return reconciled;
}

const ExecutionRunMarkerSchema = DaemonExecutionRunMarkerSchema;
const ExecutionRunMarkerOwnerWriteSchema = DaemonExecutionRunMarkerOwnerWriteSchema;
const ExecutionRunMarkerPersistenceReadSchema = createStoredReadSchema(DaemonExecutionRunMarkerPersistenceReadSchema);

export type ExecutionRunMarker = DaemonExecutionRunMarker;
type ExecutionRunMarkerPersistenceRead = DaemonExecutionRunMarkerPersistenceRead;

const RetainedWorkerUpdateSchema = z.strictObject({
  requesterWorkAttributionV1: z.optional(RequesterWorkAttributionV1Schema),
  sessionId: z.string().check(z.minLength(1)),
  localId: z.string().check(z.minLength(1)),
  update: WorkerUpdateV1Schema,
  runReportPolicy: z.optional(FollowPolicyV1Schema),
});
export type RetainedExecutionRunWorkerUpdate = z.infer<typeof RetainedWorkerUpdateSchema>;

function resolveWorkerUpdateEntry(runId: string, localId: string): string {
  return `worker-update-${digestEntryIdentity([runId, localId])}.sealed`;
}

function priorWorkerUpdateEntry(runId: string, localId: string): string {
  return `worker-update-${Buffer.from(JSON.stringify([runId, localId])).toString('base64url')}.sealed`;
}

function digestEntryIdentity(identity: readonly string[]): string {
  // Identity lives in the payload. Fixed ASCII basenames leave room for atomic
  // publication suffixes regardless of identity length or native separators.
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

async function listWorkerUpdateEntries(): Promise<readonly string[]> {
  try {
    return (await readdir(resolveExecutionRunMarkerDir())).filter((entry) => entry.startsWith('worker-update-') && entry.endsWith('.sealed'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }
}

async function readPriorWorkerUpdate(input: RetainedExecutionRunWorkerUpdate, storage: DeviceLocalSecretStorage) {
  const entry = priorWorkerUpdateEntry(input.update.workerId, input.localId);
  if (!(await listWorkerUpdateEntries()).includes(entry)) return null;
  const path = join(resolveExecutionRunMarkerDir(), entry);
  let ciphertext: string;
  try { ciphertext = await readProtectedLocalStateFile(path); }
  catch (error) { if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null; throw error; }
  const retained = createStoredReadSchema(RetainedWorkerUpdateSchema).parse(storage.openJson({
    purpose: 'execution_run_worker_update', ciphertext,
  }));
  if (JSON.stringify(retained) !== JSON.stringify(input)) {
    throw new Error('Execution-run worker update custody conflicts with the terminal observation');
  }
  return path;
}

/** Each terminal observation has immutable custody independent of the public run marker. */
export async function retainExecutionRunWorkerUpdate(input: RetainedExecutionRunWorkerUpdate): Promise<void> {
  const payload = RetainedWorkerUpdateSchema.parse(input);
  if (payload.update.workerKind !== 'execution_run') throw new Error('Expected an execution-run worker update');
  const storage = await readOrCreateDeviceLocalSecretStorage({ path: configuration.deviceLocalSecretKeyFile });
  const path = join(resolveExecutionRunMarkerDir(), resolveWorkerUpdateEntry(payload.update.workerId, payload.localId));
  await readPriorWorkerUpdate(payload, storage);
  const published = await publishProtectedLocalStateFileIfAbsent(path, storage.sealJson({
    purpose: 'execution_run_worker_update', value: payload,
  }), { authority: 'owned' });
  if (!published) {
    const retained = createStoredReadSchema(RetainedWorkerUpdateSchema).safeParse(storage.openJson({
      purpose: 'execution_run_worker_update', ciphertext: await readProtectedLocalStateFile(path),
    }));
    if (!retained.success || JSON.stringify(retained.data) !== JSON.stringify(payload)) {
      throw new Error('Execution-run worker update custody conflicts with the terminal observation');
    }
  }
  if (published) notifyExecutionRunLiveWorkChanged();
}

export async function readPendingExecutionRunWorkerUpdates(onUnavailable?: () => void): Promise<readonly RetainedExecutionRunWorkerUpdate[]> {
  const entries = await listWorkerUpdateEntries();
  pruneUnavailableRetainedEntries('worker-update-', entries);
  if (!entries.length) return [];
  const storage = await readOrCreateDeviceLocalSecretStorage({ path: configuration.deviceLocalSecretKeyFile });
  const result = new Map<string, RetainedExecutionRunWorkerUpdate>();
  for (const entry of entries) {
    const path = join(resolveExecutionRunMarkerDir(), entry);
    const observation = await retainedEntryObservation(path);
    if (unavailableRetainedEntries.has(path) && unavailableRetainedEntries.get(path)?.observation === observation) {
      onUnavailable?.();
      continue;
    }
    try {
      const ciphertext = await readProtectedLocalStateFile(path);
      const parsed = createStoredReadSchema(RetainedWorkerUpdateSchema).safeParse(storage.openJson({
        purpose: 'execution_run_worker_update',
        ciphertext,
      }));
      if (!parsed.success || parsed.data.update.workerKind !== 'execution_run'
        || resolveWorkerUpdateEntry(parsed.data.update.workerId, parsed.data.localId) !== entry
          && priorWorkerUpdateEntry(parsed.data.update.workerId, parsed.data.localId) !== entry) {
        throw new Error('Retained terminal observation could not be opened');
      }
      const currentPath = join(resolveExecutionRunMarkerDir(), resolveWorkerUpdateEntry(parsed.data.update.workerId, parsed.data.localId));
      const retained = currentPath === path ? parsed.data : await adoptPriorRetainedEntry({ runId: parsed.data.update.workerId, path, currentPath,
        validatePrior: value => {
          const prior = createStoredReadSchema(RetainedWorkerUpdateSchema).parse(storage.openJson({ purpose: 'execution_run_worker_update', ciphertext: value }));
          if (prior.update.workerKind !== 'execution_run' || priorWorkerUpdateEntry(prior.update.workerId, prior.localId) !== entry) {
            throw new Error('Retained terminal observation identity mismatch');
          }
          if (JSON.stringify(prior) !== JSON.stringify(parsed.data)) throw new Error('Retained terminal observation changed during adoption');
        },
        readCurrent: async () => {
          const current = createStoredReadSchema(RetainedWorkerUpdateSchema).parse(storage.openJson({
            purpose: 'execution_run_worker_update', ciphertext: await readProtectedLocalStateFile(currentPath),
          }));
          if (current.update.workerKind !== 'execution_run' || current.update.workerId !== parsed.data.update.workerId
            || current.localId !== parsed.data.localId) throw new Error('Retained terminal observation identity mismatch');
          if (JSON.stringify(current) !== JSON.stringify(parsed.data)) {
            throw new Error('Execution-run worker update custody conflicts with the terminal observation');
          }
          return current;
        },
      });
      unavailableRetainedEntries.delete(path);
      result.set(currentPath, retained);
    } catch (error) {
      // An exact acceptance ACK can remove an entry between the directory scan and read.
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') { unavailableRetainedEntries.delete(path); continue; }
      onUnavailable?.();
      reportUnavailableRetainedEntry(path, observation, {
        code: 'execution_run_worker_update_custody_unavailable', entry,
      }, '[executionRunRegistry] Retained worker update could not be opened');
    }
  }
  return [...result.values()];
}

/** Provider-acceptance ACK removes only the exact terminal observation it accepted. */
export async function acknowledgeExecutionRunWorkerUpdate(input: RetainedExecutionRunWorkerUpdate): Promise<boolean> {
  if (input.update.workerKind !== 'execution_run') return false;
  return serializeRetainedStateWrite(input.update.workerId, async () => {
    const path = join(resolveExecutionRunMarkerDir(), resolveWorkerUpdateEntry(input.update.workerId, input.localId));
    const storage = await readOrCreateDeviceLocalSecretStorage({ path: configuration.deviceLocalSecretKeyFile });
    try {
      const parsed = createStoredReadSchema(RetainedWorkerUpdateSchema).safeParse(storage.openJson({
        purpose: 'execution_run_worker_update', ciphertext: await readProtectedLocalStateFile(path),
      }));
      if (!parsed.success || parsed.data.update.workerKind !== 'execution_run'
        || parsed.data.update.workerId !== input.update.workerId
        || parsed.data.localId !== input.localId || parsed.data.sessionId !== input.sessionId) return false;
      const priorPath = await readPriorWorkerUpdate(parsed.data, storage);
      await acknowledgeRetainedRunTerminal(input);
      if (priorPath) await removeProtectedLocalStateFile(priorPath);
      await removeProtectedLocalStateFile(path);
      notifyExecutionRunLiveWorkChanged();
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return true;
      throw error;
    }
  });
}

function resolveExecutionRunMarkerDir(): string {
  return join(
    configuration.happyHomeDir,
    'tmp',
    resolveReleaseRingScopedBasename('daemon-execution-runs', configuration.publicReleaseRing),
  );
}

function resolveExecutionRunMarkerPath(runId: string): string {
  return join(resolveExecutionRunMarkerDir(), `run-${digestEntryIdentity([runId])}.json`);
}

function isExecutionRunMarkerEntry(entry: string): boolean {
  if (!entry.startsWith('run-')) return false;
  return entry.endsWith('.json') || entry.includes('.json.tmp-');
}

function isCanonicalExecutionRunMarkerEntry(entry: string): boolean {
  return entry.startsWith('run-') && entry.endsWith('.json');
}

async function readExecutionRunMarkerFile(path: string): Promise<ExecutionRunMarkerPersistenceRead | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = ExecutionRunMarkerPersistenceReadSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    // Current markers are scoped by this owner-local directory and intentionally
    // contain no path. A predecessor marker may still carry its old path key;
    // reject it if it names a different owner directory.
    if (parsed.data.happyHomeDir !== undefined && parsed.data.happyHomeDir !== configuration.happyHomeDir) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function shouldReplaceRecoveredMarker(params: Readonly<{
  current: ExecutionRunMarker;
  currentIsCanonical: boolean;
  next: ExecutionRunMarker;
  nextIsCanonical: boolean;
}>): boolean {
  if (params.next.updatedAtMs !== params.current.updatedAtMs) {
    return params.next.updatedAtMs > params.current.updatedAtMs;
  }
  if (params.nextIsCanonical !== params.currentIsCanonical) {
    return params.nextIsCanonical;
  }
  return false;
}

function isTerminalMarker(marker: ExecutionRunMarker): boolean {
  if (marker.status !== 'running') return true;
  return typeof marker.finishedAtMs === 'number';
}

function isRunningMarker(marker: ExecutionRunMarker): boolean {
  return marker.status === 'running' && typeof marker.finishedAtMs !== 'number';
}

async function shouldSkipOverwriteForTerminalMarker(filePath: string, next: ExecutionRunMarker, allowTerminalToRunning = false): Promise<boolean> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = ExecutionRunMarkerPersistenceReadSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return false;
    if (parsed.data.happyHomeDir !== undefined && parsed.data.happyHomeDir !== configuration.happyHomeDir) return false;
    if (isTerminalMarker(parsed.data) && isRunningMarker(next) && !allowTerminalToRunning) return true;
  } catch {
    // ignore read/parse issues
  }
  return false;
}

async function writeJsonAtomic(filePath: string, value: DaemonExecutionRunMarkerOwnerWrite, allowTerminalToRunning = false): Promise<void> {
  const tmpPath = `${filePath}.tmp-${randomUUID()}`;
  try {
    await writeFile(tmpPath, JSON.stringify(value, null, 2), 'utf-8');
    try {
      if (await shouldSkipOverwriteForTerminalMarker(filePath, value, allowTerminalToRunning)) {
        try {
          await unlink(tmpPath);
        } catch {
          // ignore
        }
        return;
      }
      await rename(tmpPath, filePath);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err?.code === 'EEXIST' || err?.code === 'EPERM') {
        if (await shouldSkipOverwriteForTerminalMarker(filePath, value, allowTerminalToRunning)) {
          try {
            await unlink(tmpPath);
          } catch {
            // ignore
          }
          return;
        }
        try {
          await unlink(filePath);
        } catch {
          // ignore
        }
        await rename(tmpPath, filePath);
        return;
      }
      throw e;
    }
  } catch (e) {
    try {
      await unlink(tmpPath);
    } catch {
      // ignore
    }
    throw e;
  }
}

export async function writeExecutionRunMarker(marker: DaemonExecutionRunMarkerOwnerWrite, options?: Readonly<{ allowTerminalToRunning?: boolean }>): Promise<void> {
  const dir = resolveExecutionRunMarkerDir();
  await mkdir(dir, { recursive: true });

  const payload = ExecutionRunMarkerOwnerWriteSchema.parse(marker);
  await writeJsonAtomic(resolveExecutionRunMarkerPath(payload.runId), payload, options?.allowTerminalToRunning === true);
  notifyExecutionRunLiveWorkChanged();
}

export async function removeExecutionRunMarker(runId: string): Promise<void> {
  const dir = resolveExecutionRunMarkerDir();
  try {
    await unlink(resolveExecutionRunMarkerPath(runId));
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code !== 'ENOENT') {
      logger.debug(`[executionRunRegistry] Failed to remove marker run-${runId}.json`, e);
    }
  }

  try {
    const entries = await readdir(dir);
    const currentEntry = `run-${digestEntryIdentity([runId])}.json`;
    const predecessorEntry = `run-${runId}.json`;
    await Promise.all(
      entries
        .filter((entry) => entry === currentEntry || entry.startsWith(`${currentEntry}.tmp-`)
          || entry === predecessorEntry || entry.startsWith(`${predecessorEntry}.tmp-`))
        .map(async (entry) => {
          // The predecessor wrote raw Run ids. Its payload reader is still the
          // authority for cleanup, including those markers and orphan temps.
          const path = join(dir, entry);
          if (entry !== currentEntry && !entry.startsWith(`${currentEntry}.tmp-`)) {
            const marker = await readExecutionRunMarkerFile(path);
            if (marker?.runId !== runId) return;
          }
          try {
            await unlink(path);
          } catch (error) {
            const unlinkErr = error as NodeJS.ErrnoException;
            if (unlinkErr?.code !== 'ENOENT') {
              logger.debug(`[executionRunRegistry] Failed to remove temp marker ${entry}`, error);
            }
          }
        }),
    );
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code !== 'ENOENT') {
      logger.debug(`[executionRunRegistry] Failed to scan temp markers for run-${runId}.json`, e);
    }
  }
  notifyExecutionRunLiveWorkChanged();
}

export async function clearExecutionRunConnectedServicesCleanupReceipt(
  runId: string,
): Promise<void> {
  const filePath = resolveExecutionRunMarkerPath(runId);
  const current = await readExecutionRunMarkerFile(filePath);
  if (!current?.executionRunConnectedServicesCleanupReceiptV1) return;
  const {
    executionRunConnectedServicesCleanupReceiptV1: _cleanupReceipt,
    executionRunConnectedServicesLaunchV1: _legacyLaunch,
    happyHomeDir: _legacyHappyHomeDir,
    ...marker
  } = current;
  const parsed = ExecutionRunMarkerOwnerWriteSchema.safeParse(marker);
  if (!parsed.success) return;
  await writeJsonAtomic(filePath, parsed.data);
  notifyExecutionRunLiveWorkChanged();
}

async function listExecutionRunMarkersRaw(onUnavailable?: () => void): Promise<ExecutionRunMarkerPersistenceRead[]> {
  const dir = resolveExecutionRunMarkerDir();
  await mkdir(dir, { recursive: true });

  const entries = await readdir(dir);
  const recovered = new Map<string, Readonly<{
    marker: ExecutionRunMarkerPersistenceRead;
    isCanonical: boolean;
  }>>();
  for (const entry of entries) {
    if (!isExecutionRunMarkerEntry(entry)) continue;
    const path = join(dir, entry);
    const marker = await readExecutionRunMarkerFile(path);
    if (!marker) { onUnavailable?.(); continue; }

    const current = recovered.get(marker.runId);
    const nextIsCanonical = isCanonicalExecutionRunMarkerEntry(entry);
    if (!current) {
      recovered.set(marker.runId, { marker, isCanonical: nextIsCanonical });
      continue;
    }
    if (
      shouldReplaceRecoveredMarker({
        current: current.marker,
        currentIsCanonical: current.isCanonical,
        next: marker,
        nextIsCanonical,
      })
    ) {
      recovered.set(marker.runId, { marker, isCanonical: nextIsCanonical });
    }
  }

  const out = Array.from(recovered.values(), (entry) => entry.marker);
  out.sort((a, b) => a.startedAtMs - b.startedAtMs);
  return out;
}

function projectExecutionRunMarkerForPublication(
  marker: ExecutionRunMarkerPersistenceRead,
): ExecutionRunMarker {
  // Launch registration is a rehydration-only compatibility fact. Public marker
  // consumers receive the bounded operational run state, never its launch config.
  const {
    executionRunConnectedServicesLaunchV1: _ownerLocalLaunch,
    executionRunConnectedServicesCleanupReceiptV1: _ownerLocalCleanupReceipt,
    ...publicMarker
  } = marker;
  return ExecutionRunMarkerSchema.parse(publicMarker);
}

export async function listExecutionRunMarkersForRehydration(): Promise<ExecutionRunMarkerPersistenceRead[]> {
  return await listExecutionRunMarkersRaw();
}

export async function listExecutionRunMarkers(): Promise<ExecutionRunMarker[]> {
  return (await listExecutionRunMarkersRaw()).map(projectExecutionRunMarkerForPublication);
}

export async function gcExecutionRunMarkers(params: Readonly<{
  nowMs: number;
  terminalTtlMs: number;
  isPidAlive: (pid: number) => boolean | Promise<boolean>;
  isPidSafeHappyProcess: (pid: number) => boolean | Promise<boolean>;
}>): Promise<{ removedRunIds: string[] }> {
  let retainedStateUnavailable = false;
  const retainedRecords = await reconcileRetainedExecutionRunRecords(params, () => { retainedStateUnavailable = true; });
  // A skipped record is not evidence that its Run/home custody can be collected.
  if (retainedStateUnavailable) return { removedRunIds: [] };
  const markers = await listExecutionRunMarkersRaw();
  let pendingCustodyUnavailable = false;
  const pending = await readPendingExecutionRunWorkerUpdates(() => { pendingCustodyUnavailable = true; });
  // A sealed payload owns its identity; an unreadable observation cannot prove
  // which Run is safe to collect. Preserve custody until it can be opened.
  if (pendingCustodyUnavailable) return { removedRunIds: [] };
  const pendingRunIds = new Set(pending.map((entry) => entry.update.workerId));
  const removedRunIds: string[] = [];

  for (const marker of markers) {
    // Pending parent delivery is retained terminal state, independent of process liveness or visibility TTL.
    if (pendingRunIds.has(marker.runId)) continue;
    const isTerminal = typeof marker.finishedAtMs === 'number' || marker.status !== 'running';
    if (isTerminal && marker.executionRunConnectedServicesCleanupReceiptV1) {
      continue;
    }
    if (isTerminal && typeof marker.finishedAtMs === 'number') {
      if (params.nowMs - marker.finishedAtMs > params.terminalTtlMs) {
        await removeExecutionRunMarker(marker.runId);
        removedRunIds.push(marker.runId);
        continue;
      }
      // A settled lifecycle outcome is no longer governed by process liveness.
      continue;
    }

    const alive = await params.isPidAlive(marker.pid);
    if (!alive) {
      await removeExecutionRunMarker(marker.runId);
      removedRunIds.push(marker.runId);
      continue;
    }

    const safe = await params.isPidSafeHappyProcess(marker.pid);
    if (!safe) {
      await removeExecutionRunMarker(marker.runId);
      removedRunIds.push(marker.runId);
      continue;
    }
  }

  for (const record of retainedRecords) {
    const run = record.state;
    if (run.retentionPolicy !== 'ephemeral' || run.status === 'running'
      || run.finishedAtMs === undefined || params.nowMs - run.finishedAtMs <= params.terminalTtlMs
      || pendingRunIds.has(run.runId)
      || markers.some((marker) => marker.runId === run.runId && marker.executionRunConnectedServicesCleanupReceiptV1)) continue;
    await serializeRetainedStateWrite(run.runId, async () => {
      const current = await readRetainedExecutionRunRecord(run.runId);
      if (current?.state.status === run.status && current.state.finishedAtMs === run.finishedAtMs) {
        await removeProtectedLocalStateFile(retainedStatePath(run.runId));
        notifyExecutionRunLiveWorkChanged();
      }
    });
  }

  return { removedRunIds };
}
