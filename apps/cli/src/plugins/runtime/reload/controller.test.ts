import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readHookEventEnvelopeV1 } from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import {
    canPluginSubscribeToEvent,
    createPluginEventsService,
} from '../context/events';

import { createPluginReloadController } from './controller';
import { readPluginReloadStateSnapshot, writePluginReloadStateSnapshot } from './state';

function createRuntimeRegistry(
    label: string,
    params?: Readonly<{
        diagnostics?: readonly PluginCompatibilityDiagnostic[];
        dispose?: () => void | Promise<void>;
        generationId?: string;
        /**
         * Diagnostics for OTHER plugins present in the same resolved registry
         * (e.g. an unrelated untrusted/pending plugin also in scope). Used to
         * verify that a blocking diagnostic on a plugin outside the reload's
         * scope does not poison this reload.
         */
        additionalPluginDiagnostics?: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
    }>,
): ResolvedExecutablePluginRuntimeRegistry {
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
            ...(params?.generationId ? { generationId: params.generationId } : {}),
        },
        actionHandlersByActionId: new Map(),
        hookHandlersByHookId: new Map(),
        runtimeCoreHandlersByBackendId: new Map(),
        agentRuntimesByAgentId: new Map(),
        daemonAuthBridgesByServiceId: new Map(),
        scmHostingProvidersById: new Map(),
        networkAllowedUrlOriginsByPluginId: new Map(),
        processSpawnAllowedPathsByPluginId: new Map(),
        pluginDiagnosticsByPluginId: Object.freeze({
            [label]: Object.freeze([...(params?.diagnostics ?? [])]),
            ...(params?.additionalPluginDiagnostics ?? {}),
        }),
        activatedPluginIds: new Set(),
        activatePluginsByEvent: async () => [],
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
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

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

    it('coalesces concurrent first runtime leases and promotes the registry as active', async () => {
        const deferred = createDeferred<ResolvedExecutablePluginRuntimeRegistry>();
        let resolveCalls = 0;
        let disposeCount = 0;
        const registry = createRuntimeRegistry('ephemeral', {
            dispose: () => {
                disposeCount += 1;
            },
        });
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => {
                resolveCalls += 1;
                return await deferred.promise;
            },
        });

        const firstLeasePromise = controller.acquireRuntimeRegistry();
        const secondLeasePromise = controller.acquireRuntimeRegistry();

        expect(resolveCalls).toBe(1);

        deferred.resolve(registry);
        const firstLease = await firstLeasePromise;
        const secondLease = await secondLeasePromise;

        expect(firstLease.registry).toBe(registry);
        expect(secondLease.registry).toBe(registry);
        expect(firstLease.source).toBe('active');
        expect(secondLease.source).toBe('active');
        expect(controller.getState().activeRegistry).toBe(registry);
        expect(controller.getState().generation).toBe(1);

        await firstLease.release();
        expect(disposeCount).toBe(0);

        await secondLease.release();
        expect(disposeCount).toBe(0);

        const thirdLease = await controller.acquireRuntimeRegistry();
        expect(thirdLease.registry).toBe(registry);
        expect(thirdLease.source).toBe('active');
        expect(resolveCalls).toBe(1);

        await thirdLease.release();
        expect(disposeCount).toBe(0);
    });

    it('does not promote a failed first runtime lease as active', async () => {
        let disposeCount = 0;
        const failedRegistry = createRuntimeRegistry('acme.broken', {
            diagnostics: [
                {
                    code: 'plugin_activation_failed',
                    message: 'activation failed',
                },
            ],
            dispose: () => {
                disposeCount += 1;
            },
        });
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => failedRegistry,
        });

        await expect(controller.acquireRuntimeRegistry()).rejects.toThrow(/no active last-known-good/i);

        expect(controller.getState()).toEqual(expect.objectContaining({
            generation: 0,
            activeRegistry: null,
            lastResult: expect.objectContaining({
                ok: false,
                registryStatus: 'unavailable',
                registry: null,
            }),
        }));
        expect(disposeCount).toBe(1);
    });

    it('reloads a healthy plugin successfully even when an unrelated untrusted plugin is in scope, and establishes a baseline', async () => {
        const registry = createRuntimeRegistry('healthy.plugin', {
            additionalPluginDiagnostics: {
                'untrusted.plugin': [
                    {
                        code: 'plugin_untrusted',
                        message: 'Plugin is untrusted and requires approval',
                    },
                ],
            },
        });
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => registry,
        });

        const result = await controller.reload({ pluginId: 'healthy.plugin' });

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            registryStatus: 'active',
            affectedPluginIds: ['healthy.plugin'],
            changedPluginIds: ['healthy.plugin'],
            registry,
        }));
        expect(controller.getState().activeRegistry).toBe(registry);
    });

    it('still fails an implicit full first-lease acquisition when the only resolved plugin is blocked (unchanged: no unrelated healthy plugin to fall back on)', async () => {
        // Documents that an implicit, scope-less first lease (`acquireRuntimeRegistry()` before
        // any explicit reload) still treats every plugin currently in the resolved registry as
        // in-scope, same as before this fix. Scoping only changes behavior for reloads that
        // explicitly target plugin id(s) (see the healthy-plugin test above) or full reloads that
        // already have a baseline to protect; it intentionally does not change the behavior for
        // an initial full/implicit resolution where nothing is affected yet.
        let disposeCount = 0;
        const failedRegistry = createRuntimeRegistry('acme.broken', {
            diagnostics: [
                {
                    code: 'plugin_activation_failed',
                    message: 'activation failed',
                },
            ],
            dispose: () => {
                disposeCount += 1;
            },
        });
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => failedRegistry,
        });

        await expect(controller.acquireRuntimeRegistry()).rejects.toThrow(/no active last-known-good/i);
        expect(disposeCount).toBe(1);
    });

    it('still rolls back to last-known-good when the reloaded plugin itself is blocked, even with an unrelated healthy plugin present', async () => {
        const goodRegistry = createRuntimeRegistry('good.plugin');
        const brokenRegistry = createRuntimeRegistry('broken.plugin', {
            diagnostics: [
                {
                    code: 'plugin_activation_failed',
                    message: 'activation failed',
                },
            ],
            additionalPluginDiagnostics: {
                'good.plugin': [],
            },
        });
        let resolveCalls = 0;
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => {
                resolveCalls += 1;
                return resolveCalls === 1 ? goodRegistry : brokenRegistry;
            },
        });

        await controller.reload({ pluginId: 'good.plugin' });
        const result = await controller.reload({ pluginId: 'broken.plugin' });

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            registryStatus: 'last_known_good',
            registry: goodRegistry,
            affectedPluginIds: ['broken.plugin'],
        }));
        expect(controller.getState().activeRegistry).toBe(goodRegistry);
    });

    it('still fails with no active last-known-good when the reloaded plugin itself is blocked and no baseline exists, despite an unrelated healthy plugin', async () => {
        const brokenRegistry = createRuntimeRegistry('broken.plugin', {
            diagnostics: [
                {
                    code: 'plugin_untrusted',
                    message: 'untrusted',
                },
            ],
            additionalPluginDiagnostics: {
                'healthy.plugin': [],
            },
        });
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => brokenRegistry,
        });

        const result = await controller.reload({ pluginId: 'broken.plugin' });

        expect(result).toEqual(expect.objectContaining({
            ok: false,
            registryStatus: 'unavailable',
            registry: null,
        }));
        expect(controller.getState().activeRegistry).toBe(null);
    });

    it('persists the normal reload generation state when the first runtime lease initializes the registry', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-plugin-first-lease-state-'));
        const registry = createRuntimeRegistry('first', {
            generationId: 'registry:first',
        });
        const controller = createPluginReloadController({
            happyHomeDir,
            resolveRuntimeRegistry: async () => registry,
        });

        const lease = await controller.acquireRuntimeRegistry();
        await lease.release();

        await expect(readPluginReloadStateSnapshot(happyHomeDir)).resolves.toEqual(expect.objectContaining({
            generation: 1,
            activeGenerationId: 'registry:first',
            changedPluginIds: ['first'],
        }));
    });

    it('disposes the active registry during daemon shutdown and clears active state', async () => {
        let disposeCount = 0;
        const registry = createRuntimeRegistry('shutdown-active', {
            dispose: () => {
                disposeCount += 1;
            },
        });
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => registry,
        });

        await controller.reload();

        await controller.shutdown({ timeoutMs: 5_000 });
        await controller.shutdown({ timeoutMs: 5_000 });

        expect(disposeCount).toBe(1);
        expect(controller.getState().activeRegistry).toBe(null);
    });

    it('bounds daemon shutdown disposal when the active registry hangs', async () => {
        vi.useFakeTimers();

        const registry = createRuntimeRegistry('shutdown-hangs', {
            dispose: async () => await new Promise<void>(() => {}),
        });
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => registry,
        });

        await controller.reload();

        let settled = false;
        const shutdown = controller.shutdown({ timeoutMs: 50 }).then(() => {
            settled = true;
        });

        await vi.advanceTimersByTimeAsync(49);
        expect(settled).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        await shutdown;

        expect(settled).toBe(true);
        expect(controller.getState().activeRegistry).toBe(null);
    });

    it('does not reacquire a runtime registry after daemon shutdown', async () => {
        let resolveCount = 0;
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => {
                resolveCount += 1;
                return createRuntimeRegistry(`shutdown-terminal-${resolveCount}`);
            },
        });

        const lease = await controller.acquireRuntimeRegistry();
        await lease.release();

        await controller.shutdown({ timeoutMs: 5_000 });

        await expect(controller.acquireRuntimeRegistry()).rejects.toThrow(/shut down/i);
        expect(resolveCount).toBe(1);
    });

    it('rejects an in-flight first runtime lease when shutdown starts before reload publication completes', async () => {
        const publishEntered = createDeferred<void>();
        const allowPublishToFinish = createDeferred<void>();
        let disposeCount = 0;
        const registry = createRuntimeRegistry('in-flight-shutdown', {
            dispose: () => {
                disposeCount += 1;
            },
        });
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => registry,
            publishInstalledManifestProjections: async () => {
                publishEntered.resolve();
                await allowPublishToFinish.promise;
            },
        });

        const leasePromise = controller.acquireRuntimeRegistry();
        await publishEntered.promise;

        await controller.shutdown({ timeoutMs: 5_000 });
        allowPublishToFinish.resolve();

        await expect(leasePromise).rejects.toThrow(/shut down/i);
        expect(disposeCount).toBe(1);
        expect(controller.getState().activeRegistry).toBe(null);
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

    it('publishes plugin reload after updates through the shared ctx.events host bus', async () => {
        const observedEvents: unknown[] = [];
        const subscription = createPluginEventsService({
            pluginId: 'happier.inspector',
            canSubscribe: (eventName) => canPluginSubscribeToEvent({
                pluginId: 'happier.inspector',
                eventName,
                permissions: new Set(['events.lifecycle.subscribe']),
            }),
        }).subscribe('@happier/lifecycle/plugin/reload/after', (event) => {
            observedEvents.push(event);
        });
        const registry = createRuntimeRegistry('acme.plugin');
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => registry,
        });

        try {
            await controller.reload({ pluginId: 'acme.plugin' });
            await vi.waitFor(() => {
                expect(observedEvents).toHaveLength(1);
            });
        } finally {
            subscription.unsubscribe();
        }

        expect(observedEvents[0]).toEqual(expect.objectContaining({
            id: '@happier/lifecycle/plugin/reload/after',
            payload: expect.objectContaining({
                eventId: 'plugin.reload.after',
                generation: 1,
                attemptedGeneration: 1,
                activeGenerationId: 'reload:1',
                registryStatus: 'active',
                affectedPluginIds: ['acme.plugin'],
                changedPluginIds: ['acme.plugin'],
            }),
            envelope: expect.objectContaining({
                source: {
                    kind: 'host',
                    namespace: 'lifecycle',
                },
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

    it('notifies subscribers once per settled reload cycle, including install-triggered and coalesced reloads', async () => {
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => createRuntimeRegistry('acme.dev'),
        });

        const notified: Array<{ affectedPluginIds: readonly string[] }> = [];
        const unsubscribe = controller.subscribe((result) => {
            notified.push({ affectedPluginIds: result.affectedPluginIds });
        });

        await controller.reload({ pluginId: 'acme.dev' });
        expect(notified).toHaveLength(1);
        expect(notified[0]).toEqual({ affectedPluginIds: ['acme.dev'] });

        unsubscribe();
        await controller.reload({ pluginId: 'acme.dev' });
        expect(notified).toHaveLength(1);
    });

    it('notifies subscribers exactly once for coalesced concurrent reloads', async () => {
        const deferred = createDeferred<ResolvedExecutablePluginRuntimeRegistry>();
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => await deferred.promise,
        });

        let notifyCount = 0;
        controller.subscribe(() => {
            notifyCount += 1;
        });

        const first = controller.reload();
        const second = controller.reload();
        deferred.resolve(createRuntimeRegistry('acme.dev'));
        await Promise.all([first, second]);

        expect(notifyCount).toBe(1);
    });
});
