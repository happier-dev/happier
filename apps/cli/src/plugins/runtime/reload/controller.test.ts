import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readHookEventEnvelopeV1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';

import { createPluginReloadController } from './controller';
import { writePluginReloadStateSnapshot } from './state';

function createRuntimeRegistry(
    label: string,
    params?: Readonly<{
        diagnostics?: readonly PluginCompatibilityDiagnostic[];
        dispose?: () => void | Promise<void>;
    }>,
): ResolvedExecutablePluginRuntimeRegistry {
    return {
        contributes: {
            providers: Object.freeze([]),
            backends: Object.freeze([]),
            actions: Object.freeze([]),
            resources: Object.freeze([]),
            uiDescriptors: Object.freeze([]),
            activationTargets: Object.freeze([]),
            hookRegistrations: Object.freeze([]),
            surfaceHandlersByBackendId: new Map(),
            catalogEntriesById: Object.freeze({}),
            providerDefinitionsById: new Map(),
            backendDefinitionsById: new Map(),
            pluginDiagnosticsByPluginId: Object.freeze({}),
        },
        actionHandlersByActionId: new Map(),
        hookHandlersByHookId: new Map(),
        runtimeCoreHandlersByBackendId: new Map(),
        backendEnginesByBackendId: new Map(),
        scmHostingProvidersById: new Map(),
        networkAllowedUrlOriginsByPluginId: new Map(),
        processSpawnAllowedPathsByPluginId: new Map(),
        pluginDiagnosticsByPluginId: Object.freeze({
            [label]: Object.freeze([...(params?.diagnostics ?? [])]),
        }),
        addRuntimeDisposable: (_pluginId, disposable) => disposable,
        readHookEventEnvelopeV1,
        dispose: async () => {
            await params?.dispose?.();
        },
    };
}

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((innerResolve, innerReject) => {
        resolve = innerResolve;
        reject = innerReject;
    });
    return { promise, resolve, reject };
}

describe('createPluginReloadController', () => {
    it('coalesces concurrent reloads and invalidates caches once for the completed generation', async () => {
        const deferred = createDeferred<ResolvedExecutablePluginRuntimeRegistry>();
        const invalidatedGenerations: number[] = [];
        let resolveCalls = 0;
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => {
                resolveCalls += 1;
                return await deferred.promise;
            },
            invalidateCaches: (generation) => {
                invalidatedGenerations.push(generation);
            },
        });

        const first = controller.reload();
        const second = controller.reload();

        expect(resolveCalls).toBe(1);
        deferred.resolve(createRuntimeRegistry('first'));

        await expect(first).resolves.toEqual(expect.objectContaining({
            ok: true,
            generation: 1,
            registryStatus: 'active',
            affectedPluginIds: ['first'],
            changedPluginIds: ['first'],
            activeGenerationId: expect.any(String),
        }));
        await expect(second).resolves.toEqual(expect.objectContaining({
            ok: true,
            generation: 1,
            registryStatus: 'active',
            affectedPluginIds: ['first'],
            changedPluginIds: ['first'],
            activeGenerationId: expect.any(String),
        }));
        expect(invalidatedGenerations).toEqual([1]);
        expect(controller.getState().generation).toBe(1);
    });

    it('reports the previous good registry as last-known-good when a later reload throws', async () => {
        let goodDisposed = false;
        const goodRegistry = createRuntimeRegistry('good', {
            dispose: () => {
                goodDisposed = true;
            },
        });
        let failNext = false;
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => {
                if (failNext) {
                    throw new Error('activation failed');
                }
                return goodRegistry;
            },
        });

        const first = await controller.reload();
        expect(first.ok).toBe(true);
        expect(controller.getState().activeRegistry).toBe(goodRegistry);

        failNext = true;
        const failed = await controller.reload({ pluginId: 'acme.broken' });

        expect(failed).toEqual(expect.objectContaining({
            ok: true,
            generation: 1,
            attemptedGeneration: 2,
            registryStatus: 'last_known_good',
            affectedPluginIds: ['acme.broken'],
            changedPluginIds: ['acme.broken'],
            registry: goodRegistry,
        }));
        expect(controller.getState().generation).toBe(1);
        expect(controller.getState().activeRegistry).toBe(goodRegistry);
        expect(goodDisposed).toBe(false);
        expect(failed.diagnostics).toEqual([
            expect.objectContaining({
                code: 'plugin_reload_failed',
                message: expect.stringMatching(/activation failed/),
            }),
        ]);
    });

    it('does not treat a persisted generation snapshot as an active last-known-good registry', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-reload-state-'));
        await writePluginReloadStateSnapshot(happyHomeDir, {
            t: 'happier_plugin_reload_state_v1',
            schemaVersion: 1,
            generation: 5,
            activeGenerationId: 'registry:previous',
            changedPluginIds: ['acme.previous'],
            updatedAt: 1,
        });
        const failedRegistry = createRuntimeRegistry('acme.broken', {
            diagnostics: [
                {
                    code: 'plugin_activation_failed',
                    message: 'activation failed',
                },
            ],
        });
        const controller = createPluginReloadController({
            happyHomeDir,
            resolveRuntimeRegistry: async () => failedRegistry,
        });

        const result = await controller.reload();

        expect(result).toEqual(expect.objectContaining({
            ok: false,
            generation: 0,
            attemptedGeneration: 1,
            activeGenerationId: null,
            registryStatus: 'unavailable',
            registry: null,
        }));
        expect(controller.getState().activeRegistry).toBe(null);
    });

    it('returns the active last-known-good registry for authoritative runtime leases after a failed reload', async () => {
        const goodRegistry = createRuntimeRegistry('good');
        let resolveCalls = 0;
        let failNext = false;
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => {
                resolveCalls += 1;
                if (failNext) {
                    throw new Error('activation failed');
                }
                return goodRegistry;
            },
        });

        await controller.reload();
        failNext = true;
        await controller.reload({ pluginId: 'acme.broken' });

        const lease = await controller.acquireRuntimeRegistry();

        expect(lease.registry).toBe(goodRegistry);
        expect(lease.source).toBe('active');
        expect(resolveCalls).toBe(2);

        await lease.release();
    });

    it('keeps the previous active registry alive until an outstanding active lease is released', async () => {
        let initialDisposeCount = 0;
        const initialRegistry = createRuntimeRegistry('initial', {
            dispose: () => {
                initialDisposeCount += 1;
            },
        });
        const nextRegistry = createRuntimeRegistry('next');
        let resolveCalls = 0;
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => {
                resolveCalls += 1;
                return resolveCalls === 1 ? initialRegistry : nextRegistry;
            },
        });

        await controller.reload();
        const lease = await controller.acquireRuntimeRegistry();

        expect(lease.registry).toBe(initialRegistry);

        const reload = await controller.reload({ pluginId: 'beta.plugin' });

        expect(reload).toEqual(expect.objectContaining({
            ok: true,
            generation: 2,
            registryStatus: 'active',
            registry: nextRegistry,
        }));
        expect(controller.getState().activeRegistry).toBe(nextRegistry);
        expect(initialDisposeCount).toBe(0);

        await lease.release();

        expect(initialDisposeCount).toBe(1);
    });

    it('emits plugin reload lifecycle hooks against the active and authoritative post-reload registries', async () => {
        const initialRegistry = createRuntimeRegistry('initial');
        const nextRegistry = createRuntimeRegistry('next');
        const dispatchReloadHookEvent = vi.fn().mockResolvedValue(undefined);
        let resolveCalls = 0;
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => {
                resolveCalls += 1;
                return resolveCalls === 1 ? initialRegistry : nextRegistry;
            },
            dispatchReloadHookEvent,
        });

        await controller.reload({ pluginId: 'alpha.plugin' });
        await controller.reload({ pluginId: 'beta.plugin' });

        expect(dispatchReloadHookEvent).toHaveBeenCalledTimes(3);
        expect(dispatchReloadHookEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
            runtimeRegistry: initialRegistry,
            eventId: 'plugin.reload.after',
            payload: expect.objectContaining({
                affectedPluginIds: ['alpha.plugin'],
                changedPluginIds: ['alpha.plugin'],
                registryStatus: 'active',
            }),
        }));
        expect(dispatchReloadHookEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
            runtimeRegistry: initialRegistry,
            eventId: 'plugin.reload.before',
            payload: expect.objectContaining({
                affectedPluginIds: ['beta.plugin'],
                currentGeneration: 1,
            }),
        }));
        expect(dispatchReloadHookEvent).toHaveBeenNthCalledWith(3, expect.objectContaining({
            runtimeRegistry: nextRegistry,
            eventId: 'plugin.reload.after',
            payload: expect.objectContaining({
                affectedPluginIds: ['beta.plugin'],
                changedPluginIds: ['beta.plugin'],
                registryStatus: 'active',
            }),
        }));
    });

    it('publishes installed plugin manifest projections after active reload without changing reload status if publishing fails', async () => {
        const registry = createRuntimeRegistry('acme.plugin');
        const publishInstalledManifestProjections = vi.fn(async () => {
            throw new Error('projection sync failed');
        });
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => registry,
            publishInstalledManifestProjections,
        });

        const result = await controller.reload({ pluginId: 'acme.plugin' });

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            generation: 1,
            registryStatus: 'active',
        }));
        expect(publishInstalledManifestProjections).toHaveBeenCalledWith({
            pluginIds: ['acme.plugin'],
        });
    });

    it('queues a follow-up targeted reload when a different plugin id is requested while a reload is already in flight', async () => {
        const firstDeferred = createDeferred<ResolvedExecutablePluginRuntimeRegistry>();
        const secondDeferred = createDeferred<ResolvedExecutablePluginRuntimeRegistry>();
        let resolveCalls = 0;
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => {
                resolveCalls += 1;
                if (resolveCalls === 1) {
                    return await firstDeferred.promise;
                }
                return await secondDeferred.promise;
            },
        });

        const first = controller.reload({ pluginId: 'alpha.plugin' });
        const second = controller.reload({ pluginId: 'beta.plugin' });

        expect(resolveCalls).toBe(1);

        firstDeferred.resolve(createRuntimeRegistry('alpha.plugin'));
        await expect(first).resolves.toEqual(expect.objectContaining({
            ok: true,
            generation: 1,
            affectedPluginIds: ['alpha.plugin'],
            changedPluginIds: ['alpha.plugin'],
        }));

        expect(resolveCalls).toBe(2);

        secondDeferred.resolve(createRuntimeRegistry('beta.plugin'));
        await expect(second).resolves.toEqual(expect.objectContaining({
            ok: true,
            generation: 2,
            requestedPluginIds: ['beta.plugin'],
            affectedPluginIds: ['beta.plugin'],
            changedPluginIds: ['beta.plugin'],
        }));
    });

    it('preserves each queued caller requested scope even when queued targeted reloads are coalesced into one run', async () => {
        const firstDeferred = createDeferred<ResolvedExecutablePluginRuntimeRegistry>();
        const secondDeferred = createDeferred<ResolvedExecutablePluginRuntimeRegistry>();
        let resolveCalls = 0;
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => {
                resolveCalls += 1;
                if (resolveCalls === 1) {
                    return await firstDeferred.promise;
                }
                return await secondDeferred.promise;
            },
        });

        const first = controller.reload({ pluginId: 'alpha.plugin' });
        const second = controller.reload({ pluginId: 'beta.plugin' });
        const third = controller.reload({ pluginId: 'gamma.plugin' });

        firstDeferred.resolve(createRuntimeRegistry('alpha.plugin'));
        await expect(first).resolves.toEqual(expect.objectContaining({
            generation: 1,
            requestedPluginIds: ['alpha.plugin'],
            affectedPluginIds: ['alpha.plugin'],
        }));

        secondDeferred.resolve(createRuntimeRegistry('beta.plugin'));

        await expect(second).resolves.toEqual(expect.objectContaining({
            generation: 2,
            requestedPluginIds: ['beta.plugin'],
            affectedPluginIds: ['beta.plugin', 'gamma.plugin'],
            changedPluginIds: ['beta.plugin', 'gamma.plugin'],
        }));
        await expect(third).resolves.toEqual(expect.objectContaining({
            generation: 2,
            requestedPluginIds: ['gamma.plugin'],
            affectedPluginIds: ['beta.plugin', 'gamma.plugin'],
            changedPluginIds: ['beta.plugin', 'gamma.plugin'],
        }));
    });
});
