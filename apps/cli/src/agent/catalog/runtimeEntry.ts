import { AGENTS } from './registry';
import type { AgentCatalogEntry, CatalogAgentId } from './types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { ResolvedAgentContribution } from '@/plugins/projection/registry/types';
import { readCurrentContributionRegistry } from './snapshot';
import { z } from 'zod/mini';

/** Executable factory facts carried only by the parent's private effect pipe. */
export const AgentSessionFactoryObservationsSchema = z.record(z.string(), z.nullable(z.strictObject({
  nativeAuthenticationRequired: z.boolean(),
})));
export type AgentSessionFactoryObservations = z.infer<typeof AgentSessionFactoryObservationsSchema>;
export type AgentSessionFactorySource = Readonly<{
  observations: AgentSessionFactoryObservations;
  isCurrent(): boolean;
}> | Readonly<{ registry: ResolvedExecutablePluginRuntimeRegistry }>;

function readCliFreeSessionDefinition(agent: ResolvedAgentContribution | undefined) {
  const definition = agent?.richDefinition?.definition;
  return definition && 'runtime' in definition && definition.runtime.kind === 'custom'
    && definition.primary === 'sessions' && definition.cli === undefined
    && agent?.cliMetadata == null && agent?.runtimeSpec == null ? definition : null;
}

/** A native factory may omit a CLI; a declaration alone never proves that factory. */
export function requiresAgentSessionCli(agentId: CatalogAgentId, registry: ResolvedExecutablePluginRuntimeRegistry): boolean {
  const agent = registry.contributes.agentDefinitionsById.get(agentId);
  const runtime = registry.agentRuntimesByAgentId.get(agentId);
  const binding = runtime?.sessionRunnerFactoryBinding;
  return !(agent && readCliFreeSessionDefinition(agent)
    && runtime?.hasPrimaryRuntime === true
    && runtime.isCurrent()
    && binding && 'locator' in binding
    && binding.agentId === agentId
    && binding.pluginId === agent.identity?.pluginId
    && binding.localAgentId === agent.identity?.localId);
}

/** Observes the same admitted factory used by Session launch, never manifest-only readiness. */
export async function observeCurrentAgentSessionFactory(agentId: CatalogAgentId, source?: AgentSessionFactorySource): Promise<Readonly<{
  nativeAuthenticationRequired: boolean;
  isCurrent(): boolean;
}> | null> {
  if (source && 'observations' in source) {
    if (!Object.hasOwn(source.observations, agentId)) throw new Error('Parent factory observation is unavailable');
    const observation = source.observations[agentId];
    return observation ? Object.freeze({ ...observation, isCurrent: source.isCurrent }) : null;
  }
  // CLI declarations can be probed in a requester worker without a daemon
  // runtime. Only a CLI-free Session needs an admitted native factory.
  const declared = (source?.registry.contributes ?? readCurrentContributionRegistry()).agentDefinitionsById.get(agentId);
  if (declared && !readCliFreeSessionDefinition(declared)) return null;
  const { acquireAuthoritativePluginRuntimeRegistryLease } = await import('@/plugins/runtime/reload/runtimeLease');
  // An unreadable runtime is not evidence that a previously admitted Agent was removed.
  const lease = source ? { registry: source.registry, release: async () => {} }
    : await acquireAuthoritativePluginRuntimeRegistryLease();
  try {
    const agent = lease.registry.contributes.agentDefinitionsById.get(agentId);
    const definition = readCliFreeSessionDefinition(agent);
    if (!definition) return null;
    const { activateAgentRuntimeContributionOnDemand } = await import('@/agent/runtime/registry/activationDemand');
    await activateAgentRuntimeContributionOnDemand(lease.registry, agentId);
    if (requiresAgentSessionCli(agentId, lease.registry)) return null;
    const runtime = lease.registry.agentRuntimesByAgentId.get(agentId)!;
    return Object.freeze({
      nativeAuthenticationRequired: Boolean(runtime.cliAuth || runtime.connectedAccountLaunch
        || definition.connectedAccounts?.length),
      isCurrent: () => lease.registry.agentRuntimesByAgentId.get(agentId) === runtime
        && !requiresAgentSessionCli(agentId, lease.registry),
    });
  } finally {
    await lease.release();
  }
}

async function acquireRegistryCatalogEntry(
  registry: ResolvedExecutablePluginRuntimeRegistry,
  agentId: CatalogAgentId,
): Promise<AgentCatalogEntry | null> {
  return registry.acquireAgentCatalogEntry
    ? await registry.acquireAgentCatalogEntry(agentId)
    : registry.contributes.agents.find((agent) => agent.id === agentId)?.catalogEntry ?? null;
}

/** The caller's existing lease owns this entry and its executable hooks. */
export async function readRegistryCatalogHook<T>(
  registry: ResolvedExecutablePluginRuntimeRegistry,
  agentId: CatalogAgentId,
  read: (entry: AgentCatalogEntry) => T | Promise<T>,
): Promise<T | null> {
  const entry = await acquireRegistryCatalogEntry(registry, agentId);
  return entry ? await read(entry) : null;
}

async function acquireCurrentCatalogEntry(
  agentId: CatalogAgentId,
): Promise<Readonly<{
  entry: AgentCatalogEntry | null;
  release(): Promise<void>;
}>> {
  const { acquireAuthoritativePluginRuntimeRegistryLease } = await import(
    '@/plugins/runtime/reload/runtimeLease'
  );
  let lease: Awaited<ReturnType<typeof acquireAuthoritativePluginRuntimeRegistryLease>>;
  try {
    lease = await acquireAuthoritativePluginRuntimeRegistryLease();
  } catch (error) {
    if (
      error instanceof Error
      && Reflect.get(error, 'code') === 'PLUGIN_DAEMON_RUNTIME_UNAVAILABLE'
    ) {
      return Object.freeze({ entry: AGENTS[agentId] ?? null, release: async () => {} });
    }
    throw error;
  }
  try {
    const entry = await acquireRegistryCatalogEntry(lease.registry, agentId);
    return Object.freeze({ entry, release: lease.release });
  } catch (error) {
    await lease.release().catch(() => {});
    throw error;
  }
}

export async function readCurrentCatalogHook<T>(
  agentId: CatalogAgentId,
  read: (entry: AgentCatalogEntry) => T | Promise<T>,
): Promise<T | null> {
  const acquired = await acquireCurrentCatalogEntry(agentId);
  try {
    return acquired.entry ? await read(acquired.entry) : null;
  } finally {
    await acquired.release();
  }
}

