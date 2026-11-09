import type { JsonValue } from '@happier-dev/protocol';

import { decodeStoredCredentials, type encodeStoredCredentials } from '@/persistence';
import type { HostBackgroundServiceProcessContext } from '@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessBootstrap';
import type { MemorySettingsV1 } from '@/settings/memorySettings';
import { timeWebLatencyPhase } from '@/daemon/externalActions/webLatencyTrace';

import { bindMemoryIndexerConnection } from './bindMemoryIndexerConnection';
import { createMemoryIndexer } from './memoryIndexer';
import type { MemoryIndexerConnection, MemoryIndexerHost, MemoryIndexerPublication } from './memoryIndexerBoundary';

// r319 nl3 replay measured 57.154 s from child birth to a public searchable
// result (including scheduling/index work). Keep one rounded startup-cost window.
export const MEMORY_INDEXER_IDLE_GRACE_MS = 57_000;

export type MemoryIndexerProcessServices = Readonly<{
  getBootstrap(): Promise<Readonly<{
    credentials: ReturnType<typeof encodeStoredCredentials>;
    machineId: string;
    settings: MemorySettingsV1;
    indexesQualified?: boolean;
  }>>;
  host: Omit<MemoryIndexerHost, 'settled'>;
  serve(connection: MemoryIndexerConnection, settle: () => Promise<void>): Promise<void>;
}>;

function readMemoryServices(value: unknown): MemoryIndexerProcessServices {
  if (typeof value !== 'object' || value === null
    || !('getBootstrap' in value) || typeof value.getBootstrap !== 'function'
    || !('serve' in value) || typeof value.serve !== 'function'
    || !('host' in value) || typeof value.host !== 'object' || value.host === null
    || !['publish', 'failed', 'readExternalSources', 'observeSessions', 'runHint', 'commitHint'].every(
      name => typeof Reflect.get(value.host as object, name) === 'function')) {
    throw new Error('memory_indexer_process_services_unavailable');
  }
  // Same-binary object capabilities come only from the daemon-bound service record.
  return value as MemoryIndexerProcessServices;
}

/** Explicit host entry; no daemon registry, discovery, wake policy or credentials on argv. */
export async function runMemoryIndexerService(context: HostBackgroundServiceProcessContext, _payload: JsonValue): Promise<void> {
  const memory = readMemoryServices(context.services.memory);
  context.signal.throwIfAborted();
  const bootstrap = await memory.getBootstrap();
  const credentials = decodeStoredCredentials(bootstrap.credentials);
  if (!credentials || !bootstrap.machineId) throw new Error('memory_indexer_process_bootstrap_invalid');
  context.signal.throwIfAborted();
  const notifications = new Set<Promise<void>>();
  let notificationFailure: unknown;
  let latest: Pick<MemoryIndexerPublication, 'settings' | 'worker' | 'embeddings'> | undefined;
  let idleGraceUntilMs: number | null = null;
  let wakeGrace: (() => void) | undefined;
  let demandDuringDrain = false;
  const notify = (result: void | Promise<void>): void => {
    const pending = Promise.resolve(result).catch(error => { notificationFailure ??= error; })
      .finally(() => { notifications.delete(pending); });
    notifications.add(pending);
  };
  const host: MemoryIndexerHost = {
    publish: snapshot => {
      latest = { settings: snapshot.settings, worker: snapshot.worker, embeddings: snapshot.embeddings };
      notify(memory.host.publish({ ...snapshot, worker: { ...snapshot.worker, idleGraceUntilMs,
        ...(idleGraceUntilMs === null ? {} : { currentPhase: 'idle_grace' }) } }));
    },
    failed: error => notify(memory.host.failed(error)),
    readExternalSources: (refresh, signal) => memory.host.readExternalSources(refresh, signal),
    observeSessions: ids => memory.host.observeSessions(ids),
    runHint: (request, signal) => memory.host.runHint(request, signal),
    commitHint: (request, signal) => memory.host.commitHint(request, signal),
  };
  const engine = await timeWebLatencyPhase('memory.startup.childEngine', () => createMemoryIndexer({ credentials, machineId: bootstrap.machineId, host,
    indexesQualified: bootstrap.indexesQualified,
    resolveExternalReader: async agentId => {
      const runtime = context.agentRuntimesByAgentId?.get(agentId);
      return runtime?.isCurrent() && !runtime.retirementSignal.aborted ? runtime.externalSessions ?? null : null;
    } }));
  const connection = bindMemoryIndexerConnection(engine, {
    beforeOperation: () => { demandDuringDrain = true; wakeGrace?.(); },
    afterOperation: signal => engine.runUntilSettled(signal),
  });
  const waitForGrace = async () => {
    demandDuringDrain = false;
    await engine.runUntilSettled(context.signal);
    // An operation arriving during the drain is already on this same process
    // channel. The serving loop joins it before admitting the next grace.
    if (demandDuringDrain || !latest?.settings.enabled || context.signal.aborted) return;
    idleGraceUntilMs = Date.now() + MEMORY_INDEXER_IDLE_GRACE_MS;
    host.publish(latest);
    await new Promise<void>(resolve => {
      const finish = () => {
        clearTimeout(timer);
        context.signal.removeEventListener('abort', finish);
        wakeGrace = undefined;
        idleGraceUntilMs = null;
        if (latest) host.publish(latest);
        resolve();
      };
      const timer = setTimeout(finish, MEMORY_INDEXER_IDLE_GRACE_MS);
      wakeGrace = finish;
      context.signal.addEventListener('abort', finish, { once: true });
      if (context.signal.aborted) finish();
    });
  };
  const abort = () => { void connection.retire().catch(() => {}); };
  context.signal.addEventListener('abort', abort, { once: true });
  try {
    context.signal.throwIfAborted();
    await timeWebLatencyPhase('memory.startup.childPolicy', () => connection.applySettings(bootstrap.settings, context.signal));
    await memory.serve(connection, waitForGrace);
  } finally {
    context.signal.removeEventListener('abort', abort);
    wakeGrace?.();
    await connection.retire();
    await Promise.all([...notifications]);
  }
  if (notificationFailure && !context.signal.aborted) throw notificationFailure;
}
