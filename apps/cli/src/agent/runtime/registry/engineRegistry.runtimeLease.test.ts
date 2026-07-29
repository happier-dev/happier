import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readHookEventEnvelopeV1 } from '@happier-dev/protocol';

import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';

import { resolveCliEngineRegistry } from './engineRegistry';

const {
    acquireAuthoritativePluginRuntimeRegistryLeaseMock,
    resolveMergedContributionRegistryMock,
    resolveExecutablePluginRuntimeRegistryMock,
    resolveEngineAdapterResolutionFromRegistryMock,
    releaseLeaseMock,
} = vi.hoisted(() => ({
    acquireAuthoritativePluginRuntimeRegistryLeaseMock: vi.fn<(...args: unknown[]) => unknown>(),
    resolveMergedContributionRegistryMock: vi.fn<(...args: unknown[]) => unknown>(),
    resolveExecutablePluginRuntimeRegistryMock: vi.fn<(...args: unknown[]) => unknown>(),
    resolveEngineAdapterResolutionFromRegistryMock: vi.fn<(...args: unknown[]) => unknown>(),
    releaseLeaseMock: vi.fn<(...args: unknown[]) => unknown>(),
}));

vi.mock('../../../plugins/runtime/reload/runtimeLease', () => ({
    acquireAuthoritativePluginRuntimeRegistryLease: acquireAuthoritativePluginRuntimeRegistryLeaseMock,
}));

vi.mock('../../../plugins/projection/registry/createResolvedContributionRegistry', () => ({
    resolveMergedContributionRegistry: resolveMergedContributionRegistryMock,
}));

vi.mock('../../../plugins/runtime/resolveExecutablePluginRuntimeRegistry', () => ({
    resolveExecutablePluginRuntimeRegistry: resolveExecutablePluginRuntimeRegistryMock,
}));

vi.mock('./engineRegistry/resolution', async (importOriginal) => ({
    ...await importOriginal<typeof import('./engineRegistry/resolution')>(),
    resolveEngineAdapterResolutionFromRegistry: resolveEngineAdapterResolutionFromRegistryMock,
}));

function createContributionRegistry(
    generationId: string,
    options?: Readonly<{ includePluginBackend?: boolean }>,
): ResolvedContributionRegistry {
    const agentDefinitionsById = new Map();
    if (options?.includePluginBackend) {
        agentDefinitionsById.set('acme.backend', {
            id: 'acme.backend',
            provenance: 'external',
            source: { kind: 'path' },
            definition: {
                kindVersion: 1,
                id: 'acme.backend',
                ownedBackendIds: ['acme.backend'],
            },
            pluginId: 'acme.plugin',
        });
    }
    return {
        generationId,
        agents: Object.freeze([]),
                actions: Object.freeze([]),
        resources: Object.freeze([]),
        uiViewsV2: Object.freeze([]),
        uiRenderersV2: Object.freeze([]),
        uiTranslationsV2: Object.freeze([]),
        activationTargets: Object.freeze([]),
                catalogEntriesById: Object.freeze({}),
        agentDefinitionsById,
        pluginDiagnosticsByPluginId: Object.freeze({}),
    };
}

function createRuntimeRegistry(contributes: ResolvedContributionRegistry): ResolvedExecutablePluginRuntimeRegistry {
    return {
        contributes,
        resolvePromptAssetBlocks: async () => [],
        activatedPluginIds: new Set(),
        activateContributionsOnDemand: async () => [],
        hookHandlersByHookId: new Map(),
        agentRuntimesByAgentId: new Map(),
        scmHostingProvidersById: new Map(),
        networkAllowedUrlOriginsByPluginId: new Map(),
        processSpawnAllowedPathsByPluginId: new Map(),
        pluginDiagnosticsByPluginId: Object.freeze({}),
        addRuntimeDisposable: (_pluginId, disposable) => disposable,
        createAgentInvocationServices: () => createUnavailablePluginServices(),
        readHookEventEnvelopeV1,
        retireConsumers: () => {},
        dispose: async () => {},
    };
}

describe('resolveCliEngineRegistry runtime lease convergence', () => {
    beforeEach(() => {
        acquireAuthoritativePluginRuntimeRegistryLeaseMock.mockReset();
        resolveMergedContributionRegistryMock.mockReset();
        resolveExecutablePluginRuntimeRegistryMock.mockReset();
        resolveEngineAdapterResolutionFromRegistryMock.mockReset();
        releaseLeaseMock.mockReset();
    });

    it('uses the authoritative plugin runtime lease for default contributions', async () => {
        const authoritativeContributes = createContributionRegistry('authoritative-runtime');
        acquireAuthoritativePluginRuntimeRegistryLeaseMock.mockResolvedValue({
            registry: createRuntimeRegistry(authoritativeContributes),
            source: 'active',
            release: releaseLeaseMock,
        });
        resolveMergedContributionRegistryMock.mockResolvedValue(createContributionRegistry('stale-merged'));
        resolveExecutablePluginRuntimeRegistryMock.mockRejectedValue(new Error('direct executable registry must not be resolved'));
        releaseLeaseMock.mockResolvedValue(undefined);

        const registry = await resolveCliEngineRegistry();

        expect(registry.contributions.generationId).toBe('authoritative-runtime');
        expect(acquireAuthoritativePluginRuntimeRegistryLeaseMock).toHaveBeenCalledTimes(1);
        expect(resolveMergedContributionRegistryMock).not.toHaveBeenCalled();
        expect(resolveExecutablePluginRuntimeRegistryMock).not.toHaveBeenCalled();
        expect(releaseLeaseMock).toHaveBeenCalledTimes(1);
    });

    it('resolves a lazy backend through a fresh serving lease after releasing the discovery snapshot', async () => {
        const generationAContributes = createContributionRegistry('generation-a', {
            includePluginBackend: true,
        });
        const generationBContributes = createContributionRegistry('generation-b', {
            includePluginBackend: true,
        });
        const generationARegistry = createRuntimeRegistry(generationAContributes);
        const generationBRegistry = createRuntimeRegistry(generationBContributes);
        const resolvedAdapter = Object.freeze({
            backendId: 'acme.backend',
            generationId: 'generation-b',
        });
        const releaseGenerationA = vi.fn(async () => undefined);
        const releaseGenerationB = vi.fn(async () => undefined);

        acquireAuthoritativePluginRuntimeRegistryLeaseMock
            .mockResolvedValueOnce({
                registry: generationARegistry,
                source: 'active',
                release: releaseGenerationA,
            })
            .mockResolvedValueOnce({
                registry: generationBRegistry,
                source: 'active',
                release: releaseGenerationB,
            });
        resolveEngineAdapterResolutionFromRegistryMock.mockResolvedValue(resolvedAdapter);

        const registry = await resolveCliEngineRegistry();
        await expect(registry.resolveForBackendId('acme.backend')).resolves.toBe(resolvedAdapter);

        expect(resolveEngineAdapterResolutionFromRegistryMock).toHaveBeenCalledWith(expect.objectContaining({
            contributions: generationBContributes,
            runtimeRegistry: generationBRegistry,
        }));
        expect(acquireAuthoritativePluginRuntimeRegistryLeaseMock).toHaveBeenCalledTimes(2);
        expect(releaseGenerationA).toHaveBeenCalledTimes(1);
        expect(releaseGenerationB).toHaveBeenCalledTimes(1);
    });

    it('does not revive a backend removed after the discovery snapshot was released', async () => {
        const generationAContributes = createContributionRegistry('generation-a', {
            includePluginBackend: true,
        });
        const generationBContributes = createContributionRegistry('generation-b');
        const releaseGenerationA = vi.fn(async () => undefined);
        const releaseGenerationB = vi.fn(async () => undefined);

        acquireAuthoritativePluginRuntimeRegistryLeaseMock
            .mockResolvedValueOnce({
                registry: createRuntimeRegistry(generationAContributes),
                source: 'active',
                release: releaseGenerationA,
            })
            .mockResolvedValueOnce({
                registry: createRuntimeRegistry(generationBContributes),
                source: 'active',
                release: releaseGenerationB,
            });

        const registry = await resolveCliEngineRegistry();

        await expect(registry.resolveForBackendId('acme.backend')).resolves.toBeNull();
        expect(resolveEngineAdapterResolutionFromRegistryMock).not.toHaveBeenCalled();
        expect(releaseGenerationA).toHaveBeenCalledTimes(1);
        expect(releaseGenerationB).toHaveBeenCalledTimes(1);
    });
});
