import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
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
    resolveContributionRuntimeCoreGetter,
} from './contributions';
import { createHostPluginContextV1 } from './pluginContext';
import {
    resolveEngineAdapterResolutionFromRegistry,
    resolveFirstPartyCatalogEntryForBackend,
} from './resolution';
import { ingestAccountConfiguredAcpBackends } from './accountConfiguredAcp';

export { createPluginExecInstallablesRegistry };

type RuntimeRegistryHandle = Readonly<{
    registry: ResolvedExecutablePluginRuntimeRegistry;
    release: () => Promise<void>;
}>;

function shouldUseAuthoritativeRuntimeLease(params?: ResolveEngineRegistryParams): boolean {
    return !params?.happyHomeDir && !params?.contributes && !params?.runtimeRegistry;
}

async function resolveDefaultContributionRegistry(
    params?: ResolveEngineRegistryParams,
): Promise<ResolvedCliEngineRegistry['contributions']> {
    if (params?.runtimeRegistry) {
        return params.runtimeRegistry.contributes;
    }
    if (params?.contributes) {
        return params.contributes;
    }
    if (shouldUseAuthoritativeRuntimeLease(params)) {
        const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
        try {
            return lease.registry.contributes;
        } finally {
            await lease.release();
        }
    }
    return await resolveMergedContributionRegistry({
        happyHomeDir: params?.happyHomeDir,
    });
}

export async function resolveCliEngineRegistry(
    params?: ResolveEngineRegistryParams,
): Promise<ResolvedCliEngineRegistry> {
    const contributions = await ingestAccountConfiguredAcpBackends(
        await resolveDefaultContributionRegistry(params),
    );
    const runtimeRegistryPromises = new Map<string, Promise<RuntimeRegistryHandle>>();
    const resolutionPromises = new Map<string, Promise<EngineAdapterResolution | null>>();

    async function resolveRuntimeRegistry(pluginId?: string | null): Promise<RuntimeRegistryHandle> {
        if (params?.runtimeRegistry) {
            return {
                registry: params.runtimeRegistry,
                release: async () => {},
            };
        }
        if (shouldUseAuthoritativeRuntimeLease(params)) {
            return await acquireAuthoritativePluginRuntimeRegistryLease();
        }
        const cacheKey = pluginId ? `plugin:${pluginId}` : 'all';
        let runtimeRegistryPromise = runtimeRegistryPromises.get(cacheKey);
        if (!runtimeRegistryPromise) {
            runtimeRegistryPromise = (async (): Promise<RuntimeRegistryHandle> => ({
                registry: await resolveExecutablePluginRuntimeRegistry({
                    happyHomeDir: params?.happyHomeDir,
                    contributes: contributions,
                    ...(pluginId ? { pluginIds: [pluginId] } : {}),
                }),
                release: async () => {},
            }))();
            runtimeRegistryPromises.set(cacheKey, runtimeRegistryPromise);
        }
        try {
            return await runtimeRegistryPromise;
        } catch (error) {
            if (runtimeRegistryPromises.get(cacheKey) === runtimeRegistryPromise) {
                runtimeRegistryPromises.delete(cacheKey);
            }
            throw error;
        }
    }

    return Object.freeze({
        contributions,
        async resolveForBackendId(backendId: string): Promise<EngineAdapterResolution | null> {
            const existing = resolutionPromises.get(backendId);
            if (existing) {
                return await existing;
            }
            const resolutionPromise = (async (): Promise<EngineAdapterResolution | null> => {
                let resolutionContributions = contributions;
                let backend = resolutionContributions.agentRuntimeDefinitionsById.get(backendId) ?? null;
                let runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry | null = null;
                let runtimeRegistryHandle: RuntimeRegistryHandle | null = null;

                const catalogEntry = backend
                    ? resolveFirstPartyCatalogEntryForBackend({
                        backend,
                        contributions: resolutionContributions,
                    })
                    : null;
                const hasExplicitRuntimeCore = backend
                    ? Boolean(resolveContributionRuntimeCoreGetter({ backend, catalogEntry }))
                    : false;
                const requiresExecutablePluginRuntimeRegistry = Boolean(
                    backend
                    && (
                        backend.provenance === 'external'
                        || backend.pluginId
                        || backend.daemonEntryPath
                        || (backend.provenance === 'first_party' && !hasExplicitRuntimeCore)
                    ),
                );

                try {
                    if (requiresExecutablePluginRuntimeRegistry && backend) {
                        runtimeRegistryHandle = await resolveRuntimeRegistry(backend.pluginId ?? null);
                        runtimeRegistry = runtimeRegistryHandle.registry;
                        await runtimeRegistry.activatePluginsByEvent(`onAgent:${backend.agentId}`);
                        resolutionContributions = runtimeRegistry.contributes;
                        backend = resolutionContributions.agentRuntimeDefinitionsById.get(backendId) ?? backend;
                    }

                    const pluginContext = createHostPluginContextV1({ ...(params ?? {}), backendId, runtimeRegistry });

                    if (!backend) {
                        return null;
                    }

                    return await resolveEngineAdapterResolutionFromRegistry({
                        backendId,
                        contributions: resolutionContributions,
                        runtimeRegistry,
                        pluginContext,
                    });
                } finally {
                    await runtimeRegistryHandle?.release();
                }
            })();
            resolutionPromises.set(backendId, resolutionPromise);
            try {
                return await resolutionPromise;
            } catch (error) {
                if (resolutionPromises.get(backendId) === resolutionPromise) {
                    resolutionPromises.delete(backendId);
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
}

export async function resolveBackendEngineAdapterResolution(
    backendId?: string | null,
    params?: ResolveEngineRegistryParams,
): Promise<EngineAdapterResolution | null> {
    if (!backendId) {
        return null;
    }
    const registry = await resolveCliEngineRegistry(params);
    return await registry.resolveForBackendId(backendId);
}

export async function resolveBackendExecutionSurfaces(
    backendId?: string | null,
    params?: ResolveEngineRegistryParams,
): Promise<BackendExecutionSurfaces> {
    const resolution = await resolveBackendEngineAdapterResolution(backendId, params);
    return resolution?.executionSurfaces ?? createEmptyBackendExecutionSurfaces();
}
