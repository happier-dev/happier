import { PluginError } from '@happier-dev/plugin-sdk';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import type { TrackedSession } from '@/daemon/types';
import type { ResolvedSessionMcpServer } from '@/mcp/runtimeTypes';
import { registerSessionSpawnResourceCleanup, type SpawnResourceCleanupByKey } from '@/daemon/sessions/cleanupSessionResources';
import { detectProviderMcpServers } from '@/mcp/providerDetection/detectProviderMcpServers';
import { RunnerPluginMcpResultSchema, type RunnerPluginMcpOperation, type RunnerPluginMcpResult } from '@/agent/runtime/session/process/runnerPluginMcpProtocol';
import { isCurrentTrackedSession, type TrackedSessionMap } from '@/daemon/sessions/sessionTrackingKey';

type Disposable = Readonly<{ dispose(): void | Promise<void> }>;
type Context = Readonly<{
  sessionId: string;
  agentId: string;
  trackedSession?: TrackedSession;
  runtimeRegistryLease?: PluginRuntimeRegistryLease;
  signal?: AbortSignal;
  isCurrent(): Promise<boolean>;
}>;

/** The daemon retains executable custody; runners receive data and an exact
 * preparation handle over the incumbent authenticated service channel. */
export function createDaemonRunnerPluginMcp(input: Readonly<{
  acquireRegistry(): Promise<PluginRuntimeRegistryLease>;
  /** Resolve private Session birth once at preparation, including cold recovery. */
  readAllowNativeAccountState(context: Context): Promise<boolean>;
  trackedSessions: TrackedSessionMap;
  spawnResourceCleanupByKey: SpawnResourceCleanupByKey;
  signal: AbortSignal;
}>) {
  const preparations = new Map<string, Readonly<{
    sessionId: string;
    tracked: TrackedSession;
    directory: string;
    allowNativeAccountState: boolean;
    lease: PluginRuntimeRegistryLease;
    lifetime: AbortController;
    attachments: Disposable[];
    pending: { value: Promise<unknown> | null };
    dispose(): Promise<void>;
  }>>();
  const unavailable = () => new PluginError({ code: 'plugin_mcp_preparation_unavailable', message: 'Plugin MCP preparation is unavailable' });
  const active = async (context: Context) => {
    context.signal?.throwIfAborted();
    input.signal.throwIfAborted();
    const tracked = context.trackedSession;
    if (!tracked || !await context.isCurrent()) throw unavailable();
    context.signal?.throwIfAborted();
    if (tracked.happySessionId !== context.sessionId || tracked.reportMarkerCustody?.retiring
      || tracked.stopRequestedAtMs !== undefined || !isCurrentTrackedSession(input.trackedSessions, tracked)) throw unavailable();
    return tracked;
  };
  return {
    async dispatch(operation: RunnerPluginMcpOperation, context: Context): Promise<RunnerPluginMcpResult> {
      if (operation.kind === 'mcp.plugin.close') {
        const preparation = preparations.get(operation.preparationId);
        if (preparation && (preparation.sessionId !== context.sessionId || preparation.tracked !== context.trackedSession)) throw unavailable();
        await preparation?.dispose();
        return { kind: 'mcp.plugin.closed' };
      }
      const tracked = await active(context);
      if (operation.kind === 'mcp.plugin.prepare') {
        if (preparations.has(operation.preparationId)) throw unavailable();
        const allowNativeAccountState = await input.readAllowNativeAccountState(context);
        const lease = context.runtimeRegistryLease ?? await input.acquireRegistry();
        const lifetime = new AbortController();
        const attachments: Disposable[] = [];
        const pending: { value: Promise<unknown> | null } = { value: null };
        let unregister: (() => void) | null = null;
        let disposePromise: Promise<void> | null = null;
        const dispose = () => {
          lifetime.abort();
          disposePromise ??= (async () => {
            // Stop can arrive while activation/connect is in flight. Join it
            // before collecting attachments so no late handle escapes cleanup.
            await pending.value?.catch(() => undefined);
            const results = await Promise.allSettled(attachments.map(attachment => attachment.dispose()));
            const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
            if (failures.length) throw new AggregateError(failures, 'Plugin MCP attachment cleanup failed');
            await lease.release();
            unregister?.();
            preparations.delete(operation.preparationId);
          })().catch(error => { disposePromise = null; throw error; });
          return disposePromise;
        };
        const preparation = { sessionId: context.sessionId, tracked, directory: operation.directory, allowNativeAccountState, lease, lifetime, attachments, pending, dispose };
        preparations.set(operation.preparationId, preparation);
        try {
          await active(context);
          unregister = registerSessionSpawnResourceCleanup({ trackingKey: tracked.trackingKey, spawnResourceCleanupByKey: input.spawnResourceCleanupByKey,
            label: operation.kind,
            isCurrentOwner: () => isCurrentTrackedSession(input.trackedSessions, tracked) && !tracked.reportMarkerCustody?.retiring,
            cleanup: dispose });
          if (!unregister || !lease.registry.projectMcpServerItems) throw unavailable();
          const projectItems = lease.registry.projectMcpServerItems;
          const projecting = (async () => {
            const items = await projectItems({ v: 1, servers: [], ...operation.catalog });
            return { items };
          })();
          pending.value = projecting;
          const projected = await projecting.finally(() => { pending.value = null; });
          await active(context);
          lifetime.signal.throwIfAborted();
          return RunnerPluginMcpResultSchema.parse({ kind: 'mcp.plugin.prepared', ...projected });
        } catch (error) { await dispose(); throw error; }
      }
      const preparation = preparations.get(operation.preparationId);
      if (!preparation || preparation.tracked !== tracked || preparation.sessionId !== context.sessionId) throw unavailable();
      // The HTTP request ends after delivery. It cannot own the published MCP
      // endpoint, whose lifetime is the preparation/Session. Cancellation while
      // constructing still retires this preparation before returning a result.
      const signal = AbortSignal.any([preparation.lifetime.signal, input.signal]);
      const onRequestAbort = () => preparation.lifetime.abort();
      context.signal?.addEventListener('abort', onRequestAbort, { once: true });
      try {
        if (operation.kind === 'mcp.plugin.discover') {
          // The plugin registry executes in the daemon process. The native
          // worker has no plugin discovery operation, so it cannot read a
          // requester's HOME. Never substitute daemon ambient config.
          if (!preparation.allowNativeAccountState) return {
            kind: 'mcp.plugin.discovered', detectedServers: [],
            unavailableReason: 'requester_native_discovery_unavailable',
          };
          const discovering = detectProviderMcpServers({ directory: preparation.directory, providers: [context.agentId],
            sessionId: context.sessionId, signal, runtimeRegistry: preparation.lease.registry });
          preparation.pending.value = discovering;
          const detected = await discovering.finally(() => { preparation.pending.value = null; });
          await active(context);
          signal.throwIfAborted();
          return RunnerPluginMcpResultSchema.parse({ kind: 'mcp.plugin.discovered', detectedServers: detected.servers });
        }
        if (!preparation.lease.registry.materializePluginMcpServers) throw unavailable();
        const materializing = preparation.lease.registry.materializePluginMcpServers({
          scope: { kind: 'session', sessionId: context.sessionId }, directory: preparation.directory, signal,
          servers: operation.servers.map(server => ({ ...server, scope: { sessionId: context.sessionId, directory: preparation.directory } })),
          addDisposable: attachment => preparation.attachments.push(attachment),
        });
        preparation.pending.value = materializing;
        const servers = await materializing.finally(() => { preparation.pending.value = null; });
        await active(context);
        signal.throwIfAborted();
        return RunnerPluginMcpResultSchema.parse({ kind: 'mcp.plugin.materialized',
          servers: servers.map(({ id, name, title, transport }: ResolvedSessionMcpServer) => ({ id, name, title, transport })) });
      } catch (error) { await preparation.dispose(); throw error; }
      finally { context.signal?.removeEventListener('abort', onRequestAbort); }
    },
    async dispose() {
      const results = await Promise.allSettled([...preparations.values()].map(preparation => preparation.dispose()));
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, 'Plugin MCP preparation cleanup failed');
    },
  };
}
