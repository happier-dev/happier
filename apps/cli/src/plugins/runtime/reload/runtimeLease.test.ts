import { afterEach, describe, expect, it, vi } from 'vitest';


import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';

import {
    acquireAuthoritativePluginRuntimeRegistryLease,
    createEphemeralPluginRuntimeRegistryLease,
    tryAcquireAuthoritativePluginRuntimeRegistryLease,
} from './runtimeLease';

function createRuntimeRegistry(durableRevision?: number): ResolvedExecutablePluginRuntimeRegistry {
    return {
        contributes: {
            agents: Object.freeze([]),
                        actions: Object.freeze([]),
            resources: Object.freeze([]),
            uiViewsV2: Object.freeze([]),
            uiRenderersV2: Object.freeze([]),
            uiTranslationsV2: Object.freeze([]),
            activationTargets: Object.freeze([]),
                        catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),
                        pluginDiagnosticsByPluginId: Object.freeze({}),
        },
        hookHandlersByHookId: new Map(),
        agentRuntimesByAgentId: new Map(),
        scmHostingProvidersById: new Map(),
        pluginDiagnosticsByPluginId: Object.freeze({}),
        ...(durableRevision === undefined ? {} : { durableRevision }),
        activatedPluginIds: new Set(),
        activateContributionsOnDemand: async () => [],
        resolvePromptAssetBlocks: async () => [],
        addRuntimeDisposable: (_pluginId, disposable) => disposable,
        createAgentInvocationServices: async () => createUnavailablePluginServices(),
        retireConsumers: () => {},
        dispose: async () => {},
    };
}

describe('acquireAuthoritativePluginRuntimeRegistryLease', () => {
    afterEach(() => {
        vi.doUnmock('@/configuration');
        vi.doUnmock('./singleton');
        vi.resetModules();
        vi.restoreAllMocks();
    });

    it('delegates to the controller runtime lease when an active registry exists', async () => {
        const activeRegistry = createRuntimeRegistry();
        const release = vi.fn().mockResolvedValue(undefined);
        const tryAcquireRuntimeRegistry = vi.fn().mockReturnValue({
            registry: activeRegistry,
            source: 'active',
            release,
        });
        const lease = await acquireAuthoritativePluginRuntimeRegistryLease({
            controller: {
                getState: vi.fn().mockReturnValue({
                    generation: 2,
                    activeRegistry,
                    lastResult: null,
                }),
                acquireRuntimeRegistry: vi.fn(),
                tryAcquireRuntimeRegistry,
            } as never,
        });

        expect(lease.registry).toBe(activeRegistry);
        expect(lease.source).toBe('active');
        expect(tryAcquireRuntimeRegistry).toHaveBeenCalledTimes(1);
        await lease.release();

        expect(release).toHaveBeenCalledTimes(1);
    });

    it('does not start plugin runtime resolution when an advisory consumer only accepts an active lease', async () => {
        const acquireRuntimeRegistry = vi.fn();
        const tryAcquireRuntimeRegistry = vi.fn().mockReturnValue(null);

        const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease({
            controller: {
                getState: vi.fn().mockReturnValue({ generation: 0, activeRegistry: null, lastResult: null }),
                acquireRuntimeRegistry,
                tryAcquireRuntimeRegistry,
            } as never,
        });

        expect(lease).toBeNull();
        expect(tryAcquireRuntimeRegistry).toHaveBeenCalledOnce();
        expect(acquireRuntimeRegistry).not.toHaveBeenCalled();
    });

    it('fails when the daemon-applied lease is unavailable', async () => {
        const acquireRuntimeRegistry = vi.fn();

        await expect(acquireAuthoritativePluginRuntimeRegistryLease({
            controller: {
                getState: () => ({
                    generation: 0,
                    activeRegistry: null,
                    lastResult: null,
                }),
                acquireRuntimeRegistry,
                tryAcquireRuntimeRegistry: () => null,
            } as never,
        })).rejects.toMatchObject({
            code: 'PLUGIN_DAEMON_RUNTIME_UNAVAILABLE',
        });

        expect(acquireRuntimeRegistry).not.toHaveBeenCalled();
    });

    it('gives direct ephemeral hook registries the same one-shot release contract', async () => {
        const registry = createRuntimeRegistry(7);
        const disposeSpy = vi.spyOn(registry, 'dispose');
        const lease = createEphemeralPluginRuntimeRegistryLease(registry);

        await lease.release();
        await lease.release();

        expect(lease.source).toBe('ephemeral');
        expect(lease.durableRevision).toBe(7);
        expect(disposeSpy).toHaveBeenCalledTimes(1);
    });

    it('uses the singleton controller when the explicit happy home is the configured home', async () => {
        vi.resetModules();

        const activeRegistry = createRuntimeRegistry();
        const release = vi.fn().mockResolvedValue(undefined);
        const tryAcquireRuntimeRegistry = vi.fn().mockReturnValue({
            registry: activeRegistry,
            source: 'active',
            release,
        });
        vi.doMock('@/configuration', () => ({
            configuration: {
                happyHomeDir: '/configured-home',
            },
        }));
        vi.doMock('./singleton', () => ({
            pluginReloadController: {
                getState: vi.fn(),
                tryAcquireRuntimeRegistry,
            },
        }));

        const { acquireAuthoritativePluginRuntimeRegistryLease: acquireLease } = await import('./runtimeLease');

        const lease = await acquireLease({
            happyHomeDir: '/configured-home',
        });

        expect(lease.registry).toBe(activeRegistry);
        expect(lease.source).toBe('active');
        expect(tryAcquireRuntimeRegistry).toHaveBeenCalledTimes(1);
        await lease.release();

        expect(release).toHaveBeenCalledTimes(1);
    });
});
