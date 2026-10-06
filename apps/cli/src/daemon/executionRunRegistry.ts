import { configuration } from '../configuration';
import { logger } from '../ui/logger';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DaemonExecutionRunMarkerPersistenceReadSchema, DaemonExecutionRunMarkerOwnerWriteSchema, DaemonExecutionRunMarkerSchema } from '@happier-dev/protocol/daemon/executionRuns';
import type { DaemonExecutionRunMarker, DaemonExecutionRunMarkerPersistenceRead, DaemonExecutionRunMarkerOwnerWrite } from '@happier-dev/protocol';
import { WorkerUpdateV1Schema } from '@happier-dev/protocol/sessions/relations/workerUpdateV1';
import { readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { z } from 'zod';
import { readOrCreateDeviceLocalSecretStorage } from './deviceLocalSecretStorage';
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

function retainedStatePath(runId: string): string {
  return join(resolveExecutionRunMarkerDir(), `state-${Buffer.from(runId).toString('base64url')}.sealed`);
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

async function readRetainedExecutionRunRecord(runId: string): Promise<RetainedExecutionRunRecord | null> {
  const storage = await readOrCreateDeviceLocalSecretStorage({ path: configuration.deviceLocalSecretKeyFile });
  try {
    return RetainedExecutionRunRecordSchema.parse(storage.openJson({
      purpose: 'execution_run_state', ciphertext: await readProtectedLocalStateFile(retainedStatePath(runId)),
    }));
  } catch (error) { if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null; throw error; }
}

async function writeRetainedExecutionRunRecord(record: RetainedExecutionRunRecord): Promise<void> {
  const storage = await readOrCreateDeviceLocalSecretStorage({ path: configuration.deviceLocalSecretKeyFile });
  await writeProtectedLocalStateFileAtomic(retainedStatePath(record.state.runId), storage.sealJson({
    purpose: 'execution_run_state', value: RetainedExecutionRunRecordSchema.parse(record),
  }), { authority: 'owned' });
}

async function acknowledgeRetainedRunTerminal(input: RetainedExecutionRunWorkerUpdate): Promise<void> {
  await serializeRetainedStateWrite(input.update.workerId, async () => {
    const record = await readRetainedExecutionRunRecord(input.update.workerId);
    if (!record) return;
    if (record.terminalEventId && input.localId === `execution-run-worker-update:${record.terminalEventId}`) {
      const { terminalEventId: _accepted, ...accepted } = record;
      await writeRetainedExecutionRunRecord(accepted);
    }
  });
}

export async function retainExecutionRunState(state: ExecutionRunState, terminalEventId?: string): Promise<void> {
  const identity = await readProcessIdentityByPid(process.pid);
  await serializeRetainedStateWrite(state.runId, async () => {
    const current = await readRetainedExecutionRunRecord(state.runId);
    const pendingEventId = terminalEventId ?? (state.status !== 'running'
      && current?.state.finishedAtMs === state.finishedAtMs ? current?.terminalEventId : undefined);
    await writeRetainedExecutionRunRecord({
      ownerPid: process.pid,
      ...(identity?.processStartTimeMs !== undefined ? { ownerProcessStartTimeMs: identity.processStartTimeMs } : {}),
      state: projectRetainedExecutionRunState(state), ...(pendingEventId ? { terminalEventId: pendingEventId } : {}),
    });
  });
}

export async function readRetainedExecutionRunRecords(): Promise<readonly RetainedExecutionRunRecord[]> {
  await Promise.all(retainedStateWrites.values());
  let entries: string[];
  try { entries = (await readdir(resolveExecutionRunMarkerDir())).filter((entry) => entry.startsWith('state-') && entry.endsWith('.sealed')); }
  catch (error) { if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return []; throw error; }
  if (!entries.length) return [];
  const storage = await readOrCreateDeviceLocalSecretStorage({ path: configuration.deviceLocalSecretKeyFile });
  const records: RetainedExecutionRunRecord[] = [];
  for (const entry of entries) {
    const path = join(resolveExecutionRunMarkerDir(), entry);
    try {
      const parsed = RetainedExecutionRunRecordSchema.safeParse(storage.openJson({
        purpose: 'execution_run_state', ciphertext: await readProtectedLocalStateFile(path),
      }));
      if (!parsed.success || retainedStatePath(parsed.data.state.runId) !== path) {
        throw Object.assign(new Error('Retained execution state could not be opened'), { code: 'execution_run_state_unavailable' });
      }
      records.push(parsed.data);
    } catch (error) {
      // Terminal GC can retire ephemeral state after the directory scan.
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }
  }
  return records;
}

/** Existing daemon process supervision feeds the lifecycle owner; transport loss never does. */
export async function reconcileRetainedExecutionRunRecords(params: Readonly<{
  nowMs: number;
  isPidAlive?: (pid: number) => boolean | Promise<boolean>;
  isPidSafeHappyProcess?: (pid: number) => boolean | Promise<boolean>;
}>): Promise<readonly RetainedExecutionRunRecord[]> {
  const records = await readRetainedExecutionRunRecords();
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
          await writeExecutionRunMarker({
            pid: record.ownerPid, happySessionId: run.sessionId, runId: run.runId, callId: run.callId,
            sidechainId: run.sidechainId, intent: run.intent, backendTarget: readBackendTargetRefV2(run.backendTarget),
            permissionMode: run.permissionMode, retentionPolicy: run.retentionPolicy, runClass: run.runClass,
            ioMode: run.ioMode, status: run.status, startedAtMs: run.startedAtMs,
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
            await retainExecutionRunWorkerUpdate(update);
          }
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
const ExecutionRunMarkerPersistenceReadSchema = DaemonExecutionRunMarkerPersistenceReadSchema;

export type ExecutionRunMarker = DaemonExecutionRunMarker;
type ExecutionRunMarkerPersistenceRead = DaemonExecutionRunMarkerPersistenceRead;

const RetainedWorkerUpdateSchema = z.object({
  sessionId: z.string().min(1),
  localId: z.string().min(1),
  update: WorkerUpdateV1Schema,
}).strict();
export type RetainedExecutionRunWorkerUpdate = z.infer<typeof RetainedWorkerUpdateSchema>;

function resolveWorkerUpdateEntry(runId: string, localId: string): string {
  // Encode the exact identities without path separators or ambiguous delimiters.
  return `worker-update-${Buffer.from(JSON.stringify([runId, localId])).toString('base64url')}.sealed`;
}

function readWorkerUpdateEntryIdentity(entry: string): readonly [string, string] | null {
  if (!entry.startsWith('worker-update-') || !entry.endsWith('.sealed')) return null;
  try {
    const parsed = z.tuple([z.string().min(1), z.string().min(1)]).safeParse(
      JSON.parse(Buffer.from(entry.slice('worker-update-'.length, -'.sealed'.length), 'base64url').toString('utf8')),
    );
    if (!parsed.success || resolveWorkerUpdateEntry(...parsed.data) !== entry) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

async function listWorkerUpdateEntries(): Promise<readonly string[]> {
  try {
    return (await readdir(resolveExecutionRunMarkerDir())).filter((entry) => readWorkerUpdateEntryIdentity(entry));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }
}

/** Each terminal observation has immutable custody independent of the public run marker. */
export async function retainExecutionRunWorkerUpdate(input: RetainedExecutionRunWorkerUpdate): Promise<void> {
  const payload = RetainedWorkerUpdateSchema.parse(input);
  if (payload.update.workerKind !== 'execution_run') throw new Error('Expected an execution-run worker update');
  const storage = await readOrCreateDeviceLocalSecretStorage({ path: configuration.deviceLocalSecretKeyFile });
  const path = join(resolveExecutionRunMarkerDir(), resolveWorkerUpdateEntry(payload.update.workerId, payload.localId));
  const published = await publishProtectedLocalStateFileIfAbsent(path, storage.sealJson({
    purpose: 'execution_run_worker_update', value: payload,
  }), { authority: 'owned' });
  if (!published) {
    const retained = RetainedWorkerUpdateSchema.safeParse(storage.openJson({
      purpose: 'execution_run_worker_update', ciphertext: await readProtectedLocalStateFile(path),
    }));
    if (!retained.success || JSON.stringify(retained.data) !== JSON.stringify(payload)) {
      throw new Error('Execution-run worker update custody conflicts with the terminal observation');
    }
  }
}

export async function readPendingExecutionRunWorkerUpdates(): Promise<readonly RetainedExecutionRunWorkerUpdate[]> {
  const entries = await listWorkerUpdateEntries();
  if (!entries.length) return [];
  const storage = await readOrCreateDeviceLocalSecretStorage({ path: configuration.deviceLocalSecretKeyFile });
  const result: RetainedExecutionRunWorkerUpdate[] = [];
  for (const entry of entries) {
    const identity = readWorkerUpdateEntryIdentity(entry)!;
    try {
      const parsed = RetainedWorkerUpdateSchema.safeParse(storage.openJson({
        purpose: 'execution_run_worker_update',
        ciphertext: await readProtectedLocalStateFile(join(resolveExecutionRunMarkerDir(), entry)),
      }));
      if (!parsed.success || parsed.data.update.workerKind !== 'execution_run'
        || parsed.data.update.workerId !== identity[0] || parsed.data.localId !== identity[1]) {
        throw new Error('Retained terminal observation could not be opened');
      }
      result.push(parsed.data);
    } catch (error) {
      // An exact acceptance ACK can remove an entry between the directory scan and read.
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      logger.warn('[executionRunRegistry] Retained worker update could not be opened', {
        code: 'execution_run_worker_update_custody_unavailable', runId: identity[0],
      });
    }
  }
  return result;
}

/** Provider-acceptance ACK removes only the exact terminal observation it accepted. */
export async function acknowledgeExecutionRunWorkerUpdate(input: RetainedExecutionRunWorkerUpdate): Promise<boolean> {
  if (input.update.workerKind !== 'execution_run') return false;
  const path = join(resolveExecutionRunMarkerDir(), resolveWorkerUpdateEntry(input.update.workerId, input.localId));
  const storage = await readOrCreateDeviceLocalSecretStorage({ path: configuration.deviceLocalSecretKeyFile });
  try {
    const parsed = RetainedWorkerUpdateSchema.safeParse(storage.openJson({
      purpose: 'execution_run_worker_update', ciphertext: await readProtectedLocalStateFile(path),
    }));
    if (!parsed.success || parsed.data.update.workerKind !== 'execution_run'
      || parsed.data.update.workerId !== input.update.workerId
      || parsed.data.localId !== input.localId || parsed.data.sessionId !== input.sessionId) return false;
    await acknowledgeRetainedRunTerminal(input);
    await removeProtectedLocalStateFile(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return true;
    throw error;
  }
}

function resolveExecutionRunMarkerDir(): string {
  return join(
    configuration.happyHomeDir,
    'tmp',
    resolveReleaseRingScopedBasename('daemon-execution-runs', configuration.publicReleaseRing),
  );
}

function resolveExecutionRunMarkerPath(runId: string): string {
  return join(resolveExecutionRunMarkerDir(), `run-${runId}.json`);
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

async function shouldSkipOverwriteForTerminalMarker(filePath: string, next: ExecutionRunMarker): Promise<boolean> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = ExecutionRunMarkerPersistenceReadSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return false;
    if (parsed.data.happyHomeDir !== undefined && parsed.data.happyHomeDir !== configuration.happyHomeDir) return false;
    if (isTerminalMarker(parsed.data) && isRunningMarker(next)
      && next.updatedAtMs <= parsed.data.updatedAtMs) return true;
  } catch {
    // ignore read/parse issues
  }
  return false;
}

async function writeJsonAtomic(filePath: string, value: DaemonExecutionRunMarkerOwnerWrite): Promise<void> {
  const tmpPath = `${filePath}.tmp-${randomUUID()}`;
  try {
    await writeFile(tmpPath, JSON.stringify(value, null, 2), 'utf-8');
    try {
      if (await shouldSkipOverwriteForTerminalMarker(filePath, value)) {
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
        if (await shouldSkipOverwriteForTerminalMarker(filePath, value)) {
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

export async function writeExecutionRunMarker(marker: DaemonExecutionRunMarkerOwnerWrite): Promise<void> {
  const dir = resolveExecutionRunMarkerDir();
  await mkdir(dir, { recursive: true });

  const { pendingWorkerUpdateCiphertext: _pending, ...payload } = ExecutionRunMarkerOwnerWriteSchema.parse(marker);
  await writeJsonAtomic(resolveExecutionRunMarkerPath(payload.runId), payload);
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
    await Promise.all(
      entries
        .filter((entry) => entry.startsWith(`run-${runId}.json.tmp-`))
        .map(async (entry) => {
          try {
            await unlink(join(dir, entry));
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
}

export async function clearExecutionRunConnectedServicesCleanupReceipt(
  runId: string,
): Promise<void> {
  const filePath = resolveExecutionRunMarkerPath(runId);
  const current = await readExecutionRunMarkerFile(filePath);
  if (!current?.executionRunConnectedServicesCleanupReceiptV1) return;
  const {
    pendingWorkerUpdateCiphertext: _pending,
    executionRunConnectedServicesCleanupReceiptV1: _cleanupReceipt,
    executionRunConnectedServicesLaunchV1: _legacyLaunch,
    happyHomeDir: _legacyHappyHomeDir,
    ...marker
  } = current;
  const parsed = ExecutionRunMarkerOwnerWriteSchema.safeParse(marker);
  if (!parsed.success) return;
  await writeJsonAtomic(filePath, parsed.data);
}

async function listExecutionRunMarkersRaw(): Promise<ExecutionRunMarkerPersistenceRead[]> {
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
    if (!marker) continue;

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
    pendingWorkerUpdateCiphertext: _pendingWorkerUpdate,
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
  const retainedRecords = await reconcileRetainedExecutionRunRecords(params);
  const markers = await listExecutionRunMarkersRaw();
  const pendingRunIds = new Set((await listWorkerUpdateEntries()).map((entry) => readWorkerUpdateEntryIdentity(entry)![0]));
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
      }
    });
  }

  return { removedRunIds };
}
