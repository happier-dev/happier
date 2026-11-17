import { PluginError } from '@happier-dev/plugin-sdk';
import type { BackgroundServiceRunner } from '@happier-dev/plugin-sdk/background-services';
import { MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1, type HostEvents } from '@happier-dev/plugin-sdk/events';
import type { DaemonDatabase, DaemonDatabaseService, DaemonDatabaseRetentionChange, PluginAccountStorageScope } from '@happier-dev/plugin-sdk/storage';
import { createPostgresqlObservationNormalizer } from '@happier-dev/databases/postgresql';
import { bindLocalCapture } from './launch.js';
import { createCaptureRuntime, type CaptureRuntime } from './runtime.js';
import { captureDatabaseDefinition } from './store/capture.js';
import { readCapturePreference, type CaptureProjectScope } from './configuration.js';

export type LocalCaptureInput = Omit<Parameters<typeof bindLocalCapture>[0], 'runtime'> & Readonly<{
 projectScope: CaptureProjectScope; ownerAccountId: string; physicalRootIdentity: string;
}>;
type LocalCaptureLease = Awaited<ReturnType<typeof bindLocalCapture>>;
type PartitionListener = (partitions: readonly string[]) => void;
type CaptureRuntimeContext = { signal: AbortSignal; services: { storage: { daemon: DaemonDatabaseService; account?: PluginAccountStorageScope } } };
type RunningCapture = {
 runtime: CaptureRuntime;
 signal: AbortSignal;
 accountStorage: PluginAccountStorageScope | undefined;
 leases: Map<LocalCaptureLease, CaptureProjectScope & Readonly<{ ownerAccountId: string }>>;
 pending: Set<Promise<LocalCaptureLease>>;
};

/** Role demands share one writer; the local runner alone admits local listeners. */
export function createCaptureBackgroundOwner() {
 let running: RunningCapture | null = null;
 type Binding = { database: DaemonDatabase; signal: AbortSignal };
 let shared: { runtime: CaptureRuntime; bindings: Set<Binding> } | null = null;
 const listeners = new Map<string, Set<PartitionListener>>();
 function publish(partitions: readonly string[]) {
  for (const partition of partitions) for (const listener of listeners.get(partition) ?? []) listener([partition]);
 }
 const databaseDefinition = { ...captureDatabaseDefinition, onRetention(change: DaemonDatabaseRetentionChange) { publish(change.keys); } };
 async function acquireRuntime(context: CaptureRuntimeContext): Promise<{ runtime: CaptureRuntime; release(): Promise<void> }> {
  const binding = { database: await context.services.storage.daemon.database('capture', { ...databaseDefinition, signal: context.signal }), signal: context.signal };
  if (!shared) {
   const bindings = new Set<Binding>();
   const active = () => {
    for (const selected of bindings) if (!selected.signal.aborted) return selected.database;
    throw new PluginError({ code: 'plugin_service_unavailable', message: 'Capture storage has no active role' });
   };
   // SDK handles belong to their invocation. One writer delegates through an active role's
   // handle; the daemon database owner still owns the one underlying database connection.
   const database: DaemonDatabase = {
    query: (...args) => active().query(...args),
    execute: (...args) => active().execute(...args),
    transaction: (...args) => active().transaction(...args),
   };
   shared = { runtime: createCaptureRuntime({ database, normalizeStatement: createPostgresqlObservationNormalizer(), publish }), bindings };
  }
  const state = shared;
  state.bindings.add(binding);
  let released: Promise<void> | undefined;
  return { runtime: state.runtime, release() {
   if (!released) {
    state.bindings.delete(binding);
    if (!state.bindings.size && shared === state) shared = null;
    released = state.bindings.size ? Promise.resolve() : state.runtime.ingest.settled();
   }
   return released;
  } };
 }
 const run = async (context: CaptureRuntimeContext & { services: { events: { host: HostEvents } } }): Promise<void> => {
  const runtimeLease = await acquireRuntime(context);
  if (context.signal.aborted) { await runtimeLease.release(); return; }
  const state: RunningCapture = {
   runtime: runtimeLease.runtime,
   signal: context.signal, accountStorage: context.services.storage.account, leases: new Map(), pending: new Set(),
  };
  running = state;
  const removal = context.services.events.host.subscribe({ eventId: MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1, scope: { kind: 'account' } }, async ({ payload }) => {
   if (payload.kind === 'worktreeRemoved') await state.runtime.removeWorktree(payload.removal.worktreePath);
  });
  try {
   await new Promise<void>(resolve => {
    if (context.signal.aborted) resolve();
    else context.signal.addEventListener('abort', () => resolve(), { once: true });
   });
  } finally {
   removal.dispose();
   running = null;
   await Promise.allSettled([...state.pending]);
   const releases = await Promise.allSettled([...state.leases.keys()].map(lease => lease.stopRecording()));
   await state.runtime.ingest.settled();
   await runtimeLease.release();
   const failures = releases.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
   if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Local capture cleanup failed');
  }
 };
 return {
  databaseDefinition,
  acquireRuntime,
  async readEnabled(scope: CaptureProjectScope): Promise<boolean> { return await readCapturePreference(running?.accountStorage, scope); },
  /** Stops only the requesting Account's own recordings of this project. */
  async stopProjectCapture(scope: CaptureProjectScope, ownerAccountId: string): Promise<void> {
   const state = running;
   if (!state) return;
   await Promise.allSettled([...state.pending]);
   await Promise.all([...state.leases].filter(([, selected]) => selected.ownerAccountId === ownerAccountId && selected.serverId === scope.serverId
    && selected.machineId === scope.machineId && selected.projectId === scope.projectId).map(([lease]) => lease.stopRecording()));
  },
  run: run satisfies BackgroundServiceRunner,
  readRuntime(): CaptureRuntime | null { return shared?.runtime ?? null; },
  subscribe(partition: string, listener: PartitionListener): () => void {
   const selected = listeners.get(partition) ?? new Set<PartitionListener>();
   listeners.set(partition, selected);
   selected.add(listener);
   return () => { selected.delete(listener); if (!selected.size) listeners.delete(partition); };
  },
  async acquireLocalCapture(input: LocalCaptureInput): Promise<LocalCaptureLease> {
   const state = running;
   if (!state || state.signal.aborted) throw new PluginError({ code: 'plugin_service_unavailable', message: 'Local database capture is not running' });
   const acquisition = (async () => {
    await state.runtime.rememberWorktree(input.partition, input.physicalRootIdentity);
    return await bindLocalCapture({ ...input, runtime: state.runtime });
   })().then(bound => {
    const lease: LocalCaptureLease = { ...bound, async release() {
     try { await bound.release(); } finally { state.leases.delete(lease); }
    } };
    state.leases.set(lease, { ...input.projectScope, ownerAccountId: input.ownerAccountId });
    return lease;
   });
   state.pending.add(acquisition);
   void acquisition.then(() => state.pending.delete(acquisition), () => state.pending.delete(acquisition));
   return await acquisition;
  },
 };
}

export const localCaptureBackground = createCaptureBackgroundOwner();
