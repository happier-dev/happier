import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readHookEventEnvelopeV1 } from '@happier-dev/protocol';

import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';

import { resolveCliEngineRegistry } from './engineRegistry';

const {
    resolveMergedContributionRegistryMock,
    acquireAuthoritativePluginRuntimeRegistryLeaseMock,
    resolveEngineAdapterResolutionFromRegistryMock,
    releaseRuntimeRegistryLeaseMock,
} = vi.hoisted(() => ({
    resolveMergedContributionRegistryMock: vi.fn<(...args: unknown[]) => unknown>(),
    acquireAuthoritativePluginRuntimeRegistryLeaseMock: vi.fn<(...args: unknown[]) => unknown>(),
    resolveEngineAdapterResolutionFromRegistryMock: vi.fn<(...args: unknown[]) => unknown>(),
    releaseRuntimeRegistryLeaseMock: vi.fn(async () => undefined),
}));

vi.mock('../../../plugins/projection/registry/createResolvedContributionRegistry', () => ({
    resolveMergedContributionRegistry: resolveMergedContributionRegistryMock,
}));

vi.mock('../../../plugins/runtime/reload/runtimeLease', () => ({
    acquireAuthoritativePluginRuntimeRegistryLease: acquireAuthoritativePluginRuntimeRegistryLeaseMock,
}));

vi.mock('./engineRegistry/resolution', async (importOriginal) => ({
    ...await importOriginal<typeof import('./engineRegistry/resolution')>(),
    resolveEngineAdapterResolutionFromRegistry: resolveEngineAdapterResolutionFromRegistryMock,
}));

function createContributionRegistry(params?: Readonly<{
    generationId?: string;
    includePluginBackend?: boolean;
}>): ResolvedContributionRegistry {
    const agentDefinitionsById = new Map();
    const pluginCatalogEntries = Object.freeze({});

    if (params?.includePluginBackend !== false) {
        agentDefinitionsById.set('acme.retry.backend', {
            id: 'acme.retry.backend',
            provenance: 'external',
            source: { kind: 'path' },
            definition: {
                kindVersion: 1,
                id: 'acme.retry.backend',
                ownedBackendIds: ['acme.retry.backend'],
            },
            pluginId: 'acme.retry.plugin',
        });
    }

    return {
        generationId: params?.generationId ?? 'retry-registry',
        agents: Object.freeze([]),
                actions: Object.freeze([]),
        resources: Object.freeze([]),
        uiViewsV2: Object.freeze([]),
        uiRenderersV2: Object.freeze([]),
        uiTranslationsV2: Object.freeze([]),
        activationTargets: Object.freeze([]),
                catalogEntriesById: pluginCatalogEntries,
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

describe('resolveCliEngineRegistry retry cache eviction', () => {
    beforeEach(() => {
        resolveMergedContributionRegistryMock.mockReset();
        acquireAuthoritativePluginRuntimeRegistryLeaseMock.mockReset();
        resolveEngineAdapterResolutionFromRegistryMock.mockReset();
        releaseRuntimeRegistryLeaseMock.mockClear();
    });

    it('retries canonical runtime lease acquisition after a transient failure', async () => {
        const contributions = createContributionRegistry();
        const runtimeRegistry = createRuntimeRegistry(createContributionRegistry({ generationId: 'runtime-registry' }));
        const resolution = Object.freeze({ backendId: 'acme.retry.backend', source: 'second-attempt' });

        resolveMergedContributionRegistryMock.mockResolvedValue(contributions);
        acquireAuthoritativePluginRuntimeRegistryLeaseMock
            .mockRejectedValueOnce(new Error('temporary runtime registry failure'))
            .mockResolvedValueOnce({
                registry: runtimeRegistry,
                source: 'active',
                release: releaseRuntimeRegistryLeaseMock,
            });
        resolveEngineAdapterResolutionFromRegistryMock.mockResolvedValue(resolution);

        const registry = await resolveCliEngineRegistry({ happyHomeDir: '/tmp/retry-home' });

        await expect(registry.resolveForBackendId('acme.retry.backend')).rejects.toThrow('temporary runtime registry failure');
        await expect(registry.resolveForBackendId('acme.retry.backend')).resolves.toBe(resolution);

        expect(acquireAuthoritativePluginRuntimeRegistryLeaseMock).toHaveBeenCalledTimes(2);
        expect(resolveEngineAdapterResolutionFromRegistryMock).toHaveBeenCalledTimes(1);
        expect(releaseRuntimeRegistryLeaseMock).toHaveBeenCalledTimes(1);
    });

    it('retries backend resolution after a transient failure and reacquires the canonical lease', async () => {
        const contributions = createContributionRegistry();
        const runtimeRegistry = createRuntimeRegistry(createContributionRegistry({ generationId: 'runtime-registry' }));
        const resolution = Object.freeze({ backendId: 'acme.retry.backend', source: 'retry-success' });

        resolveMergedContributionRegistryMock.mockResolvedValue(contributions);
        acquireAuthoritativePluginRuntimeRegistryLeaseMock.mockResolvedValue({
            registry: runtimeRegistry,
            source: 'active',
            release: releaseRuntimeRegistryLeaseMock,
        });
        resolveEngineAdapterResolutionFromRegistryMock
            .mockRejectedValueOnce(new Error('temporary backend resolution failure'))
            .mockResolvedValueOnce(resolution);

        const registry = await resolveCliEngineRegistry({ happyHomeDir: '/tmp/retry-home' });

        await expect(registry.resolveForBackendId('acme.retry.backend')).rejects.toThrow('temporary backend resolution failure');
        await expect(registry.resolveForBackendId('acme.retry.backend')).resolves.toBe(resolution);

        expect(acquireAuthoritativePluginRuntimeRegistryLeaseMock).toHaveBeenCalledTimes(2);
        expect(resolveEngineAdapterResolutionFromRegistryMock).toHaveBeenCalledTimes(2);
        expect(releaseRuntimeRegistryLeaseMock).toHaveBeenCalledTimes(2);
    });
});
