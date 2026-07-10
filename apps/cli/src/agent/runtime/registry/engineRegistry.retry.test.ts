import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readHookEventEnvelopeV1 } from '@happier-dev/protocol';

import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

import { resolveCliEngineRegistry } from './engineRegistry';

const {
    resolveMergedContributionRegistryMock,
    resolveExecutablePluginRuntimeRegistryMock,
    resolveEngineAdapterResolutionFromRegistryMock,
} = vi.hoisted(() => ({
    resolveMergedContributionRegistryMock: vi.fn<(...args: unknown[]) => unknown>(),
    resolveExecutablePluginRuntimeRegistryMock: vi.fn<(...args: unknown[]) => unknown>(),
    resolveEngineAdapterResolutionFromRegistryMock: vi.fn<(...args: unknown[]) => unknown>(),
}));

vi.mock('../../../plugins/projection/registry/createResolvedContributionRegistry', () => ({
    resolveMergedContributionRegistry: resolveMergedContributionRegistryMock,
}));

vi.mock('../../../plugins/runtime/resolveExecutablePluginRuntimeRegistry', () => ({
    resolveExecutablePluginRuntimeRegistry: resolveExecutablePluginRuntimeRegistryMock,
}));

vi.mock('./engineRegistry/resolution', () => ({
    resolveEngineAdapterResolutionFromRegistry: resolveEngineAdapterResolutionFromRegistryMock,
}));

function createContributionRegistry(params?: Readonly<{
    generationId?: string;
    includePluginBackend?: boolean;
}>): ResolvedContributionRegistry {
    const agentRuntimeDefinitionsById = new Map();
    const agentDefinitionsById = new Map();
    const pluginCatalogEntries = Object.freeze({});

    if (params?.includePluginBackend !== false) {
        agentRuntimeDefinitionsById.set('acme.retry.backend', {
            id: 'acme.retry.backend',
            agentId: 'acme.retry.provider',
            provenance: 'external',
            source: { kind: 'path' },
            definition: {
                kindVersion: 1,
                id: 'acme.retry.backend',
                agentId: 'acme.retry.provider',
                label: 'Acme Retry Backend',
            },
            pluginId: 'acme.retry.plugin',
            daemonEntryPath: '/plugins/acme.retry/daemon.mjs',
        });
        agentDefinitionsById.set('acme.retry.provider', {
            id: 'acme.retry.provider',
            provenance: 'external',
            source: { kind: 'path' },
            definition: {
                kindVersion: 1,
                id: 'acme.retry.provider',
                ownedBackendIds: ['acme.retry.backend'],
            },
            pluginId: 'acme.retry.plugin',
        });
    }

    return {
        generationId: params?.generationId ?? 'retry-registry',
        agents: Object.freeze([]),
        agentRuntimes: Object.freeze([]),
        actions: Object.freeze([]),
        resources: Object.freeze([]),
        uiDescriptors: Object.freeze([]),
        activationTargets: Object.freeze([]),
        hookRegistrations: Object.freeze([]),
        surfaceHandlersByBackendId: new Map(),
        catalogEntriesById: pluginCatalogEntries,
        agentDefinitionsById,
        agentRuntimeDefinitionsById,
        pluginDiagnosticsByPluginId: Object.freeze({}),
    };
}

function createRuntimeRegistry(contributes: ResolvedContributionRegistry): ResolvedExecutablePluginRuntimeRegistry {
    return {
        contributes,
        activatedPluginIds: new Set(),
        activatePluginsByEvent: async () => [],
        actionHandlersByActionId: new Map(),
        hookHandlersByHookId: new Map(),
        runtimeCoreHandlersByBackendId: new Map(),
        agentRuntimesByAgentId: new Map(),
        scmHostingProvidersById: new Map(),
        networkAllowedUrlOriginsByPluginId: new Map(),
        processSpawnAllowedPathsByPluginId: new Map(),
        pluginDiagnosticsByPluginId: Object.freeze({}),
        addRuntimeDisposable: (_pluginId, disposable) => disposable,
        readHookEventEnvelopeV1,
        dispose: async () => {},
    };
}

describe('resolveCliEngineRegistry retry cache eviction', () => {
    beforeEach(() => {
        resolveMergedContributionRegistryMock.mockReset();
        resolveExecutablePluginRuntimeRegistryMock.mockReset();
        resolveEngineAdapterResolutionFromRegistryMock.mockReset();
    });

    it('retries runtime registry resolution after a transient executable-registry load failure on the same registry object', async () => {
        const contributions = createContributionRegistry();
        const runtimeRegistry = createRuntimeRegistry(createContributionRegistry({ generationId: 'runtime-registry' }));
        const resolution = Object.freeze({ backendId: 'acme.retry.backend', source: 'second-attempt' });

        resolveMergedContributionRegistryMock.mockResolvedValue(contributions);
        resolveExecutablePluginRuntimeRegistryMock
            .mockRejectedValueOnce(new Error('temporary runtime registry failure'))
            .mockResolvedValueOnce(runtimeRegistry);
        resolveEngineAdapterResolutionFromRegistryMock.mockResolvedValue(resolution);

        const registry = await resolveCliEngineRegistry({ happyHomeDir: '/tmp/retry-home' });

        await expect(registry.resolveForBackendId('acme.retry.backend')).rejects.toThrow('temporary runtime registry failure');
        await expect(registry.resolveForBackendId('acme.retry.backend')).resolves.toBe(resolution);

        expect(resolveExecutablePluginRuntimeRegistryMock).toHaveBeenCalledTimes(2);
        expect(resolveEngineAdapterResolutionFromRegistryMock).toHaveBeenCalledTimes(1);
    });

    it('retries backend resolution after a transient resolution failure while reusing a successful runtime registry promise', async () => {
        const contributions = createContributionRegistry();
        const runtimeRegistry = createRuntimeRegistry(createContributionRegistry({ generationId: 'runtime-registry' }));
        const resolution = Object.freeze({ backendId: 'acme.retry.backend', source: 'retry-success' });

        resolveMergedContributionRegistryMock.mockResolvedValue(contributions);
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue(runtimeRegistry);
        resolveEngineAdapterResolutionFromRegistryMock
            .mockRejectedValueOnce(new Error('temporary backend resolution failure'))
            .mockResolvedValueOnce(resolution);

        const registry = await resolveCliEngineRegistry({ happyHomeDir: '/tmp/retry-home' });

        await expect(registry.resolveForBackendId('acme.retry.backend')).rejects.toThrow('temporary backend resolution failure');
        await expect(registry.resolveForBackendId('acme.retry.backend')).resolves.toBe(resolution);

        expect(resolveExecutablePluginRuntimeRegistryMock).toHaveBeenCalledTimes(1);
        expect(resolveEngineAdapterResolutionFromRegistryMock).toHaveBeenCalledTimes(2);
    });
});
