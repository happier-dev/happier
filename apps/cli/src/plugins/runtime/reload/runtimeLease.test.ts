import { afterEach, describe, expect, it, vi } from 'vitest';

import { readHookEventEnvelopeV1 } from '@happier-dev/protocol';

import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

import { acquireAuthoritativePluginRuntimeRegistryLease } from './runtimeLease';

function createRuntimeRegistry(label: string): ResolvedExecutablePluginRuntimeRegistry {
    return {
        contributes: {
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
            generationId: `registry:${label}`,
        },
        actionHandlersByActionId: new Map(),
        hookHandlersByHookId: new Map(),
        runtimeCoreHandlersByBackendId: new Map(),
        agentRuntimesByAgentId: new Map(),
        daemonAuthBridgesByServiceId: new Map(),
        scmHostingProvidersById: new Map(),
        networkAllowedUrlOriginsByPluginId: new Map(),
        processSpawnAllowedPathsByPluginId: new Map(),
        pluginDiagnosticsByPluginId: Object.freeze({}),
        activatedPluginIds: new Set(),
        activatePluginsByEvent: async () => [],
        addRuntimeDisposable: (_pluginId, disposable) => disposable,
        readHookEventEnvelopeV1,
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
        const activeRegistry = createRuntimeRegistry('active');
        const release = vi.fn().mockResolvedValue(undefined);
        const acquireRuntimeRegistry = vi.fn().mockResolvedValue({
            registry: activeRegistry,
            source: 'active',
            release,
        });
        const resolveRuntimeRegistry = vi.fn();

        const lease = await acquireAuthoritativePluginRuntimeRegistryLease({
            controller: {
                getState: vi.fn().mockReturnValue({
                    generation: 2,
                    activeRegistry,
                    lastResult: null,
                }),
                reload: vi.fn(),
                acquireRuntimeRegistry,
            } as never,
            resolveRuntimeRegistry,
        });

        expect(lease.registry).toBe(activeRegistry);
        expect(lease.source).toBe('active');
        expect(acquireRuntimeRegistry).toHaveBeenCalledTimes(1);
        expect(resolveRuntimeRegistry).not.toHaveBeenCalled();

        await lease.release();

        expect(release).toHaveBeenCalledTimes(1);
    });

    it('disposes an ephemeral runtime registry when no active registry exists', async () => {
        const ephemeralRegistry = createRuntimeRegistry('ephemeral');
        const disposeSpy = vi.spyOn(ephemeralRegistry, 'dispose');
        const resolveRuntimeRegistry = vi.fn().mockResolvedValue(ephemeralRegistry);

        const lease = await acquireAuthoritativePluginRuntimeRegistryLease({
            controller: {
                getState: () => ({
                    generation: 0,
                    activeRegistry: null,
                    lastResult: null,
                }),
                reload: vi.fn(),
            } as never,
            resolveRuntimeRegistry,
        });

        expect(lease.registry).toBe(ephemeralRegistry);
        expect(lease.source).toBe('ephemeral');

        await lease.release();

        expect(disposeSpy).toHaveBeenCalledTimes(1);
    });

    it('uses the singleton controller when the explicit happy home is the configured home', async () => {
        vi.resetModules();

        const activeRegistry = createRuntimeRegistry('configured-home');
        const release = vi.fn().mockResolvedValue(undefined);
        const acquireRuntimeRegistry = vi.fn().mockResolvedValue({
            registry: activeRegistry,
            source: 'active',
            release,
        });
        const resolveRuntimeRegistry = vi.fn();

        vi.doMock('@/configuration', () => ({
            configuration: {
                happyHomeDir: '/configured-home',
            },
        }));
        vi.doMock('./singleton', () => ({
            pluginReloadController: {
                getState: vi.fn(),
                reload: vi.fn(),
                acquireRuntimeRegistry,
            },
        }));

        const { acquireAuthoritativePluginRuntimeRegistryLease: acquireLease } = await import('./runtimeLease');

        const lease = await acquireLease({
            happyHomeDir: '/configured-home',
            resolveRuntimeRegistry,
        });

        expect(lease.registry).toBe(activeRegistry);
        expect(lease.source).toBe('active');
        expect(acquireRuntimeRegistry).toHaveBeenCalledTimes(1);
        expect(resolveRuntimeRegistry).not.toHaveBeenCalled();

        await lease.release();

        expect(release).toHaveBeenCalledTimes(1);
    });
});
