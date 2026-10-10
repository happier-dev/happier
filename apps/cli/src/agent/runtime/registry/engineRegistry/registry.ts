import type { BackendTargetRefV2 } from '@happier-dev/protocol';

import { createResolvedContributionRegistry, resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import {
    createEmptyBackendExecutionSurfaces,
    type BackendExecutionSurfaces,
    type EngineAdapterResolution,
    type ResolvedCliEngineRegistry,
} from '../engineRegistryTypes';
import type { ResolveEngineRegistryParams } from './types';
import {
    createPluginExecInstallablesRegistry,
    projectEngineRuntimeContributionFromAgent,
    resolveEngineBackendIdForCatalogAgent,
    resolveEngineRuntimeContribution,
} from './contributions';
import {
    resolveEngineAdapterResolutionFromRegistry,
} from './resolution';
import { AgentExecutionTargetV1Schema, type AgentExecutionTargetV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { indexAgentRoutingIdsByContributionIdentity, readAgentRoutingIdForContributionIdentity } from '@/plugins/projection/registry/agentRoutingIdentity';
import { activateAgentRuntimeContributionOnDemand } from '../activationDemand';
import {
    buildExecutionRunProfileCatalog,
    type ExecutionRunProfileContributionCatalogInput,
} from '@/agent/executionRuns/profiles/intentRegistry';

export { createPluginExecInstallablesRegistry };

type RuntimeRegistryHandle = Readonly<{
    registry: ResolvedExecutablePluginRuntimeRegistry;
    resolveCurrentPluginMaterializationRef?: NonNullable<
        ResolvedExecutablePluginRuntimeRegistry['resolveCurrentPluginMaterializationRef']
    >;
    resolveCurrentMediatorContributionMaterializationRef?: NonNullable<
        ResolvedExecutablePluginRuntimeRegistry['resolveCurrentMediatorContributionMaterializationRef']
    >;
    release: () => Promise<void>;
}>;

function shouldUseAuthoritativeRuntimeLease(params?: ResolveEngineRegistryParams): boolean {
    return !params?.happyHomeDir
        && !params?.contributes
        && !params?.runtimeRegistry
        && !params?.requireRunnerAgentSessionRuntimeSource
        && !params?.runnerAgentSessionRuntimeSource;
}

async function resolveDefaultContributionRegistry(
    params?: ResolveEngineRegistryParams,
): Promise<Readonly<{
    contributions: ResolvedCliEngineRegistry['contributions'];
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry | null;
    release: (() => Promise<void>) | null;
}>> {
    if (params?.runtimeRegistry) {
        return {
            contributions: params.runtimeRegistry.contributes,
            runtimeRegistry: params.runtimeRegistry,
            release: null,
        };
    }
    if (params?.contributes) {
        return {
            contributions: params.contributes,
            runtimeRegistry: null,
            release: null,
        };
    }
    const runnerSource = params?.runnerAgentSessionRuntimeSource;
    if (runnerSource && params?.backendId === runnerSource.identity.backendId) {
        // The daemon already supplied this Session's exact Agent declaration.
        // Discovery cannot replace it; executable authority is still claimed by
        // the runner source before its runtime or services can be reached.
        return {
            contributions: createResolvedContributionRegistry({ agents: [runnerSource.agentContribution] }),
            runtimeRegistry: null,
            release: null,
        };
    }
    if (shouldUseAuthoritativeRuntimeLease(params)) {
        const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
        return {
            contributions: lease.registry.contributes,
            // This lease only protects the synchronous discovery snapshot. Lazy executable
            // resolution must acquire the then-serving registry instead of retaining a
            // released registry through the returned engine-registry closure.
            runtimeRegistry: null,
            release: lease.release,
        };
    }
    return {
        contributions: await resolveMergedContributionRegistry({
            happyHomeDir: params?.happyHomeDir,
        }),
        runtimeRegistry: null,
        release: null,
    };
}

export async function resolveCliEngineRegistry(
    params?: ResolveEngineRegistryParams,
): Promise<ResolvedCliEngineRegistry> {
    const defaultRegistry = await resolveDefaultContributionRegistry(params);
    const contributions = defaultRegistry.contributions;
    const agentRoutingIds = indexAgentRoutingIdsByContributionIdentity([...contributions.agentDefinitionsById.values()]);
    const resolutionPromises = new Map<string, Promise<EngineAdapterResolution | null>>();

    async function resolveRuntimeRegistry(pluginId?: string | null): Promise<RuntimeRegistryHandle> {
        const snapshotRuntimeRegistry = params?.runtimeRegistry ?? defaultRegistry.runtimeRegistry;
        if (snapshotRuntimeRegistry) {
            return {
                registry: snapshotRuntimeRegistry,
                resolveCurrentPluginMaterializationRef:
                    snapshotRuntimeRegistry.resolveCurrentPluginMaterializationRef,
                resolveCurrentMediatorContributionMaterializationRef:
                    snapshotRuntimeRegistry.resolveCurrentMediatorContributionMaterializationRef,
                release: async () => {},
            };
        }
        void pluginId;
        return await acquireAuthoritativePluginRuntimeRegistryLease({
            happyHomeDir: params?.happyHomeDir,
        });
    }

    const registry = Object.freeze({
        contributions,
        async resolveExecutionRunProfileCatalog(options = {}) {
            const runtimeRegistryHandle = await resolveRuntimeRegistry();
            try {
                return buildExecutionRunProfileCatalog(
                    (runtimeRegistryHandle.registry.contributes.executionRunProfiles ?? [])
                        .flatMap<ExecutionRunProfileContributionCatalogInput>((profile) => {
                            if (!profile.pluginId) return [profile.definition];
                            const current = runtimeRegistryHandle.registry
                                .pluginFinalPolicyCurrentRuntimesById
                                ?.get(profile.pluginId) ?? null;
                            return current?.applied === true
                                ? [{
                                    pluginId: profile.pluginId,
                                    sourceCustody: current.sourceCustody,
                                    definition: profile.definition,
                                }]
                                : [];
                        }),
                    options,
                );
            } finally {
                await runtimeRegistryHandle.release();
            }
        },
        async resolveForAgentTarget(target: AgentExecutionTargetV1): Promise<EngineAdapterResolution | null> {
            const agentTarget = AgentExecutionTargetV1Schema.parse(target);
            const routingId = readAgentRoutingIdForContributionIdentity(agentRoutingIds, agentTarget.identity);
            if (!routingId) return null;
            const backendId = resolveEngineBackendIdForCatalogAgent(contributions, routingId);
            return backendId ? await this.resolveForBackendId(backendId, agentTarget) : null;
        },
        async resolveForBackendId(backendId: string, agentTarget = params?.agentTarget): Promise<EngineAdapterResolution | null> {
            if (agentTarget) {
                const routingId = readAgentRoutingIdForContributionIdentity(agentRoutingIds, agentTarget.identity);
                const targetBackendId = routingId
                    ? resolveEngineBackendIdForCatalogAgent(contributions, routingId)
                    : null;
                if (targetBackendId !== backendId) {
                    throw Object.assign(new Error('Selected Agent target does not match its contributed runtime'), {
                        code: 'AGENT_TARGET_CONTRIBUTION_MISMATCH',
                    });
                }
            }
            const cacheKey = agentTarget ? buildBackendTargetKeyV2(agentTarget) : backendId;
            const existing = resolutionPromises.get(cacheKey);
            if (existing) {
                return await existing;
            }
            const resolutionPromise = (async (): Promise<EngineAdapterResolution | null> => {
                let resolutionContributions = contributions;
                const matchingRunnerSessionRuntimeSource =
                    params?.runnerAgentSessionRuntimeSource?.identity.backendId
                            === backendId
                        ? params.runnerAgentSessionRuntimeSource
                        : null;
                let backend = matchingRunnerSessionRuntimeSource
                    ? projectEngineRuntimeContributionFromAgent(
                        matchingRunnerSessionRuntimeSource.agentContribution,
                        backendId,
                    )
                    : resolveEngineRuntimeContribution(
                        resolutionContributions,
                        backendId,
                    );
                let runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry | null = null;
                let runtimeRegistryHandle: RuntimeRegistryHandle | null = null;

                const hasMatchingRunnerSessionRuntimeSource =
                    matchingRunnerSessionRuntimeSource !== null;
                const requiresExecutablePluginRuntimeRegistry = Boolean(
                    backend
                    && !hasMatchingRunnerSessionRuntimeSource
                );
                if (
                    params?.requireRunnerAgentSessionRuntimeSource
                    && backend
                    && params.runnerAgentSessionRuntimeSource?.identity.backendId !== backend.id
                ) {
                    const error = new Error(
                        `Daemon-spawned native Agent backend '${backend.id}' is missing its runner-local runtime source`,
                    ) as Error & { code: string };
                    error.code = 'RUNNER_AGENT_SESSION_RUNTIME_SOURCE_MISSING';
                    throw error;
                }

                try {
                    if (requiresExecutablePluginRuntimeRegistry && backend) {
                        runtimeRegistryHandle = await resolveRuntimeRegistry(backend.pluginId ?? null);
                        runtimeRegistry = runtimeRegistryHandle.registry;
                        resolutionContributions = runtimeRegistry.contributes;
                        backend = matchingRunnerSessionRuntimeSource
                            ? projectEngineRuntimeContributionFromAgent(
                                matchingRunnerSessionRuntimeSource.agentContribution,
                                backendId,
                            )
                            : resolveEngineRuntimeContribution(
                                resolutionContributions,
                                backendId,
                            );
                        if (!backend) {
                            return null;
                        }
                        if (backend.pluginId) {
                            await activateAgentRuntimeContributionOnDemand(
                                runtimeRegistry,
                                backend.agentId,
                            );
                        }
                        resolutionContributions = runtimeRegistry.contributes;
                        backend = matchingRunnerSessionRuntimeSource
                            ? projectEngineRuntimeContributionFromAgent(
                                matchingRunnerSessionRuntimeSource.agentContribution,
                                backendId,
                            )
                            : resolveEngineRuntimeContribution(
                                resolutionContributions,
                                backendId,
                            );
                    }

                    if (!backend) {
                        return null;
                    }

                    return await resolveEngineAdapterResolutionFromRegistry({
                        backendId,
                        agentTarget,
                        startupRuntimeDescriptorV1: params?.startupRuntimeDescriptorV1,
                        savedSecretOperationContext: params?.savedSecretOperationContext,
                        contributions: resolutionContributions,
                        runtimeRegistry,
                        ...(runtimeRegistryHandle?.resolveCurrentPluginMaterializationRef
                            ? {
                                resolveCurrentPluginMaterializationRef:
                                    runtimeRegistryHandle.resolveCurrentPluginMaterializationRef,
                            }
                            : {}),
                        ...(runtimeRegistryHandle?.resolveCurrentMediatorContributionMaterializationRef
                            ? {
                                resolveCurrentMediatorContributionMaterializationRef:
                                    runtimeRegistryHandle
                                        .resolveCurrentMediatorContributionMaterializationRef,
                            }
                            : {}),
                        ...(params?.happyHomeDir ? { happyHomeDir: params.happyHomeDir } : {}),
                        runnerAgentSessionRuntimeSource:
                            params?.runnerAgentSessionRuntimeSource ?? null,
                        ...(params?.prepareTeamCredentialProviderBinding
                            ? {
                                prepareTeamCredentialProviderBinding:
                                    params.prepareTeamCredentialProviderBinding,
                            }
                            : {}),
                    });
                } finally {
                    await runtimeRegistryHandle?.release();
                }
            })();
            resolutionPromises.set(cacheKey, resolutionPromise);
            try {
                const resolution = await resolutionPromise;
                // Account rows can change independently of this plugin registry.
                // Share in-flight work, but do not retain a configured launch or miss.
                if ((!resolution || agentTarget?.definitionId !== undefined || params?.startupRuntimeDescriptorV1?.agent !== undefined || params?.runnerAgentSessionRuntimeSource?.startupRuntimeDescriptorV1?.agent !== undefined)
                    && resolutionPromises.get(cacheKey) === resolutionPromise) {
                    resolutionPromises.delete(cacheKey);
                }
                return resolution;
            } catch (error) {
                if (resolutionPromises.get(cacheKey) === resolutionPromise) {
                    resolutionPromises.delete(cacheKey);
                }
                throw error;
            }
        },
        async resolveExecutionSurfaces(backendId?: string | null): Promise<BackendExecutionSurfaces> {
            if (!backendId) {
                return createEmptyBackendExecutionSurfaces();
            }
            const resolution = await this.resolveForBackendId(backendId);
            return resolution?.executionSurfaces ?? createEmptyBackendExecutionSurfaces();
        },
    });
    await defaultRegistry.release?.();
    return registry;
}

export async function resolveBackendEngineAdapterResolution(
    backendId?: string | null,
    params?: ResolveEngineRegistryParams,
): Promise<EngineAdapterResolution | null> {
    if (!backendId && !params?.agentTarget) {
        return null;
    }
    const registry = await resolveCliEngineRegistry({ ...params, backendId });
    if (backendId) return await registry.resolveForBackendId(backendId);
    return params?.agentTarget ? await registry.resolveForAgentTarget(params.agentTarget) : null;
}

export async function resolveBackendExecutionSurfaces(
    target?: string | BackendTargetRefV2 | null,
    params?: ResolveEngineRegistryParams,
): Promise<BackendExecutionSurfaces> {
    if (typeof target === 'object' && target?.sourceKind === 'configured') {
        // Retained backend references carry no executable contribution authority.
        return createEmptyBackendExecutionSurfaces();
    }
    const backendId = typeof target === 'string' ? target : target?.backendId;
    const resolution = await resolveBackendEngineAdapterResolution(backendId, params);
    return resolution?.executionSurfaces ?? createEmptyBackendExecutionSurfaces();
}
