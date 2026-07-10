import { describe, expect, it, vi } from 'vitest';

import { readHookEventEnvelopeV1 } from '@happier-dev/protocol';

import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

import { resolveCliEngineRegistry } from './engineRegistry';

const {
    acquireAuthoritativePluginRuntimeRegistryLeaseMock,
    resolveMergedContributionRegistryMock,
    resolveExecutablePluginRuntimeRegistryMock,
    releaseLeaseMock,
} = vi.hoisted(() => ({
    acquireAuthoritativePluginRuntimeRegistryLeaseMock: vi.fn<(...args: unknown[]) => unknown>(),
    resolveMergedContributionRegistryMock: vi.fn<(...args: unknown[]) => unknown>(),
    resolveExecutablePluginRuntimeRegistryMock: vi.fn<(...args: unknown[]) => unknown>(),
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

function createContributionRegistry(generationId: string): ResolvedContributionRegistry {
    return {
        generationId,
        agents: Object.freeze([]),
        agentRuntimes: Object.freeze([]),
        actions: Object.freeze([]),
        resources: Object.freeze([]),
        uiDescriptors: Object.freeze([]),
        activationTargets: Object.freeze([]),
        hookRegistrations: Object.freeze([]),
        surfaceHandlersByBackendId: new Map(),
        catalogEntriesById: Object.freeze({}),
        agentDefinitionsById: new Map(),
        agentRuntimeDefinitionsById: new Map(),
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

describe('resolveCliEngineRegistry runtime lease convergence', () => {
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
});
