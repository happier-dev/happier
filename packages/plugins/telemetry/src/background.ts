import { PluginError } from '@happier-dev/plugin-sdk';
import type { BackgroundServiceContext, BackgroundServiceRunner } from '@happier-dev/plugin-sdk/background-services';
import type { DatabaseCaptureSourceV1 } from '@happier-dev/database-protocol';
import { MACHINE_WORKTREE_REMOVED_HOST_EVENT_V1, type HostEvents } from '@happier-dev/plugin-sdk/events';
import type { DaemonDatabase, DaemonDatabaseService, DaemonDatabaseRetentionChange, PluginAccountStorageScope } from '@happier-dev/plugin-sdk/storage';
import { createPostgresqlObservationNormalizer } from '@happier-dev/databases/postgresql';
import { bindLocalCapture } from './launch.js';
import { createCaptureRuntime, type CaptureRuntime } from './runtime.js';
import { captureDatabaseDefinition } from './store/capture.js';
import { readCapturePreference, type CaptureProjectScope } from './configuration.js';
import { createDatabaseFindingPublisher, selectWorktreeFindingSubjects } from './telemetry/databaseFindings.js';

export type LocalCaptureInput = Omit<Parameters<typeof bindLocalCapture>[0], 'runtime' | 'onBindingStart' | 'onWorktreeTracesCommitted'> & Readonly<{
 projectScope: CaptureProjectScope; ownerAccountId: string;
 worktreeSource?: Extract<DatabaseCaptureSourceV1, { kind: 'worktree' }>;
}>;
type LocalCaptureLease = Awaited<ReturnType<typeof bindLocalCapture>>;
type LocalCaptureProject = CaptureProjectScope & { ownerAccountId: string };
type LocalCaptureBinding = LocalCaptureProject & {
 partition: string;
 restartRequired?: true;
};
type PartitionListener = () => void;
type CaptureRuntimeContext = { signal: AbortSignal; services: { storage: { daemon: Pick<DaemonDatabaseService, 'database'>; account?: PluginAccountStorageScope } } };
type RunningCapture = {
 runtime: CaptureRuntime;
 signal: AbortSignal;
 accountStorage: PluginAccountStorageScope | undefined;
 publishWorktreeFindings?: (input: Parameters<ReturnType<typeof createDatabaseFindingPublisher>>[0]) => void;
 leases: Map<LocalCaptureLease, LocalCaptureBinding>;
 pending: Map<Promise<LocalCaptureLease>, LocalCaptureProject & Pick<LocalCaptureInput, 'partition' | 'signal'>>;
};

/** Role demands share one writer; the local runner alone admits local listeners. */
export function createCaptureBackgroundOwner() {
 let running: RunningCapture | null = null;
 type Binding = { database: DaemonDatabase; signal: AbortSignal };
 let shared: { runtime: CaptureRuntime; bindings: Set<Binding> } | null = null;
 const listeners = new Map<string, Set<PartitionListener>>();
 function publish(partitions: readonly string[]) {
  const affected = new Set<PartitionListener>();
  for (const partition of partitions) for (const listener of listeners.get(partition) ?? []) affected.add(listener);
  for (const listener of affected) listener();
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
 const run = async (context: CaptureRuntimeContext & { services: {
  events: { host: HostEvents; plugin?: BackgroundServiceContext['services']['events']['plugin'] };
  logger?: BackgroundServiceContext['services']['logger'];
 } }): Promise<void> => {
  const runtimeLease = await acquireRuntime(context);
  if (context.signal.aborted) { await runtimeLease.release(); return; }
  const { plugin } = context.services.events;
  const { logger } = context.services;
  const publisher = plugin && createDatabaseFindingPublisher(runtimeLease.runtime, {
   signal: context.signal, services: { events: { plugin } },
  });
  const state: RunningCapture = {
   ...(publisher && logger && { publishWorktreeFindings(input) {
    void publisher(input).catch(() => {
     if (!context.signal.aborted) logger.warn('Database Capture finding delivery is unavailable');
    });
   } }),
   runtime: runtimeLease.runtime,
   signal: context.signal, accountStorage: context.services.storage.account, leases: new Map(), pending: new Map(),
  };
  running = state;
  const removal = context.services.events.host.subscribe({ eventId: MACHINE_WORKTREE_REMOVED_HOST_EVENT_V1, scope: { kind: 'machine' } },
   ({ payload }) => state.runtime.removeWorktree(payload.physicalRoot));
  try {
   await new Promise<void>(resolve => {
    if (context.signal.aborted) resolve();
    else context.signal.addEventListener('abort', () => resolve(), { once: true });
   });
  } finally {
   removal.dispose();
   running = null;
   await Promise.allSettled([...state.pending.keys()]);
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
  readWorktreeLaunchStatus(partition: string): { preparing?: true; restartRequired?: true } {
   const state = running;
   if (!state) return {};
   const status: { preparing?: true; restartRequired?: true } = {};
   for (const binding of state.pending.values()) {
    if (binding.partition === partition && !binding.signal.aborted) {
     status.preparing = true;
     break;
    }
   }
   for (const binding of state.leases.values()) {
    if (binding.partition === partition && binding.restartRequired) {
     status.restartRequired = true;
     break;
    }
   }
   return status;
  },
  /** Stops only the requesting Account's own recordings of this project. */
  async stopProjectCapture(scope: CaptureProjectScope, ownerAccountId: string): Promise<void> {
   const state = running;
   if (!state) return;
   const matches = (selected: LocalCaptureProject) => selected.ownerAccountId === ownerAccountId && selected.serverId === scope.serverId
    && selected.machineId === scope.machineId && selected.projectId === scope.projectId;
   await Promise.allSettled([...state.pending].filter(([, selected]) => matches(selected)).map(([acquisition]) => acquisition));
   const changed = new Set<string>();
   await Promise.all([...state.leases].filter(([, selected]) => matches(selected)).map(async ([lease, selected]) => {
    await lease.stopRecording();
    if (selected.restartRequired || (lease.endpoint === undefined && Object.keys(lease.replacements).length === 0)) return;
    selected.restartRequired = true;
    if (state.leases.has(lease)) changed.add(selected.partition);
   }));
   if (running === state && changed.size > 0) publish([...changed]);
  },
  run: run satisfies BackgroundServiceRunner,
  readRuntime(): CaptureRuntime | null { return shared?.runtime ?? null; },
  subscribe(partitions: readonly string[], listener: PartitionListener): () => void {
   for (const partition of partitions) {
    const selected = listeners.get(partition) ?? new Set<PartitionListener>();
    listeners.set(partition, selected);
    selected.add(listener);
   }
   return () => {
    for (const partition of partitions) {
     const selected = listeners.get(partition);
     if (selected?.delete(listener) && !selected.size) listeners.delete(partition);
    }
   };
  },
  async acquireLocalCapture(input: LocalCaptureInput): Promise<LocalCaptureLease> {
   const state = running;
   if (!state || state.signal.aborted) throw new PluginError({ code: 'plugin_service_unavailable', message: 'Local database capture is not running' });
   let bindingStarted = false;
   const { worktreeSource, partition } = input;
   const publishFindings = state.publishWorktreeFindings;
   const acquisition = bindLocalCapture({ ...input, runtime: state.runtime,
    onBindingStart() { bindingStarted = true; },
    ...(publishFindings && worktreeSource && { onWorktreeTracesCommitted(traceIds, subjects) {
     const { serverId, machineId } = worktreeSource;
     publishFindings({ source: worktreeSource, sourceScope: { serverId, machineId }, partition, traceIds,
      selectSubjects: trace => selectWorktreeFindingSubjects(trace, subjects),
     });
    } }),
   }).then(bound => {
    const binding: LocalCaptureBinding = { ...input.projectScope, ownerAccountId: input.ownerAccountId, partition: input.partition };
    const lease: LocalCaptureLease = { ...bound, async release() {
     try { await bound.release(); } finally {
      if (state.leases.delete(lease) && binding.restartRequired && running === state) publish([binding.partition]);
     }
    } };
    state.leases.set(lease, binding);
    return lease;
   });
   if (bindingStarted) {
    state.pending.set(acquisition, { ...input.projectScope, ownerAccountId: input.ownerAccountId, partition: input.partition, signal: input.signal });
    const settled = () => state.pending.delete(acquisition);
    void acquisition.then(settled, settled);
   }
   return await acquisition;
  },
 };
}

export const localCaptureBackground = createCaptureBackgroundOwner();
