import { configuration } from '@/configuration';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import type { ProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';
import { createResolvedContributionRegistry, selectPluginContributionInputs } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveUnavailableAgentPluginsByBackendId } from '@/plugins/projection/registry/builtIn/snapshot';
import type { PluginProjectAdmissionRefusalV1 } from '@happier-dev/protocol/plugins/availability/v1';

type PluginRuntimeLease = Awaited<
    ReturnType<typeof acquireAuthoritativePluginRuntimeRegistryLease>
>;

/** Owns the one plugin runtime lease shared across connected-service, Provider, and Agent spawn preparation. */
export function createSpawnPluginRuntimeLease(
    launchResourceScope: ProviderLaunchResourceScope,
    admitProject?: (registry: PluginRuntimeLease['registry']) => Promise<ReadonlyMap<string, PluginProjectAdmissionRefusalV1>>,
) {
    let lease: PluginRuntimeLease | null = null;
    let released = false;
    let projectRefusals: ReadonlyMap<string, PluginProjectAdmissionRefusalV1> | undefined;

    const release = async () => {
        if (!lease || released) return;
        released = true;
        const ownedLease = lease;
        lease = null;
        await ownedLease.release();
    };

    return {
        get currentRegistry(): PluginRuntimeLease['registry'] | null {
            return released ? null : lease?.registry ?? null;
        },
        get projectRefusals() { return projectRefusals; },
        async acquire(): Promise<PluginRuntimeLease> {
            if (lease && !released) return lease;
            released = false;
            lease = await acquireAuthoritativePluginRuntimeRegistryLease({
                happyHomeDir: configuration.happyHomeDir,
                recoverAccountCensus: true,
            });
            launchResourceScope.register(release);
            const registry = lease.registry;
            const refusals = await admitProject?.(registry);
            projectRefusals = refusals?.size ? refusals : undefined;
            if (refusals?.size) {
                const enablement = { ...registry.contributes.pluginEnablementById };
                for (const [pluginId, unavailableCode] of refusals) {
                    const previous = enablement[pluginId] ?? { machineEnabled: true };
                    enablement[pluginId] = { ...previous, enabled: false, unavailableCode };
                }
                const included = (pluginId: string | undefined) => pluginId === undefined || !refusals.has(pluginId);
                const selected = selectPluginContributionInputs(registry.contributes, included);
                const unavailableAgents = { ...registry.contributes.unavailableAgentPluginsByBackendId,
                    ...resolveUnavailableAgentPluginsByBackendId(enablement) };
                for (const agent of registry.contributes.agents) {
                    if (!agent.pluginId || !refusals.has(agent.pluginId)) continue;
                    const fact = enablement[agent.pluginId]!;
                    const unavailable = { ...fact, pluginId: agent.pluginId, code: refusals.get(agent.pluginId)! };
                    unavailableAgents[agent.id] = unavailable;
                    for (const backendId of agent.definition.ownedBackendIds ?? []) unavailableAgents[backendId] = unavailable;
                }
                lease = { ...lease, registry: { ...registry,
                    contributes: createResolvedContributionRegistry({ ...selected, pluginEnablementById: enablement,
                        unavailableAgentPluginsByBackendId: unavailableAgents }),
                } };
            }
            return lease;
        },
        release,
    };
}

export type SpawnPluginRuntimeLease = ReturnType<typeof createSpawnPluginRuntimeLease>;
