import type { CatalogAgentLookupId } from '@/agent/catalog/ids';
import type { AgentCatalogEntry } from '@/agent/catalog/types';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { ProviderProbeCancelledError } from '@/providers/probe/client';
import type { PreflightCatalogCleanupScope } from './preflightCatalogCleanupScope';

type AgentPreflightCatalogContext = Readonly<{
  catalogEntry?: AgentCatalogEntry | null;
  runtimeCacheKey?: string;
  registrySnapshot?: ResolvedContributionRegistry;
  isCurrent: () => boolean;
}>;

/** Keeps RPC and local Action probes on one demanded Agent occurrence for their whole operation. */
export async function withAgentPreflightCatalog<T>(
  params: Readonly<{
    agentId: CatalogAgentLookupId;
    signal?: AbortSignal;
    isCurrent?: () => boolean;
    cleanupScope?: PreflightCatalogCleanupScope;
  }>,
  run: (context: AgentPreflightCatalogContext) => Promise<T>,
): Promise<T> {
  const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
  let rejectAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    if (!params.signal) return;
    rejectAbort = () => reject(params.signal?.reason ?? new ProviderProbeCancelledError());
    params.signal.addEventListener('abort', rejectAbort, { once: true });
  });
  try {
    params.signal?.throwIfAborted();
    // Standalone processes retain declaration-only behavior; never create a
    // second runtime authority just to enumerate a catalog.
    const catalogEntry = lease
      ? await Promise.race([Promise.resolve(lease.registry.acquireAgentCatalogEntry?.(params.agentId)), aborted]) ?? null
      : undefined;
    const pluginId = lease?.registry.contributes.agentDefinitionsById.get(params.agentId)?.identity?.pluginId;
    const runtimeCacheKey = pluginId ? lease?.registry.readPluginOccurrenceId?.(pluginId) ?? undefined : undefined;
    const isCurrent = () => params.signal?.aborted !== true
      && (params.isCurrent?.() ?? true)
      && (!lease || pluginReloadController.isRuntimeRegistryCurrent(lease.registry));
    if (!isCurrent()) throw new ProviderProbeCancelledError();
    const result = await Promise.race([run({
      ...(lease ? { catalogEntry, runtimeCacheKey, registrySnapshot: lease.registry.contributes } : {}),
      isCurrent,
    }), aborted]);
    if (!isCurrent()) throw new ProviderProbeCancelledError();
    return result;
  } finally {
    if (rejectAbort) params.signal?.removeEventListener('abort', rejectAbort);
    try { await params.cleanupScope?.dispose(); } finally { await lease?.release(); }
  }
}
