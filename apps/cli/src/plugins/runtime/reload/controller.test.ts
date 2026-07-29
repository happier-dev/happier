import { readHookEventEnvelopeV1 } from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';

import { createPluginReloadController } from './controller';

function createRuntimeRegistry(
    label: string,
    params?: Readonly<{
        diagnostics?: readonly PluginCompatibilityDiagnostic[];
        dispose?: ResolvedExecutablePluginRuntimeRegistry['dispose'];
        retireConsumers?: ResolvedExecutablePluginRuntimeRegistry['retireConsumers'];
        retirePluginConsumers?: (pluginIds: readonly string[]) => void;
        generationId?: string;
        additionalPluginDiagnostics?: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
    }>,
): ResolvedExecutablePluginRuntimeRegistry {
    return {
        contributes: {
            agents: Object.freeze([]),
                        providers: Object.freeze([]),
            actions: Object.freeze([]),
            resources: Object.freeze([]),
            uiViewsV2: Object.freeze([]),
            uiRenderersV2: Object.freeze([]),
            uiTranslationsV2: Object.freeze([]),
            activationTargets: Object.freeze([]),
                        catalogEntriesById: Object.freeze({}),
            agentDefinitionsById: new Map(),
                        pluginDiagnosticsByPluginId: Object.freeze({}),
            ...(params?.generationId ? { generationId: params.generationId } : {}),
        },
        hookHandlersByHookId: new Map(),
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
        activateContributionsOnDemand: async () => [],
        resolvePromptAssetBlocks: async () => [],
        retireConsumers: params?.retireConsumers ?? (() => undefined),
        retirePluginConsumers: params?.retirePluginConsumers ?? (() => undefined),
        addRuntimeDisposable: (_pluginId, disposable) => disposable,
        createAgentInvocationServices: () => createUnavailablePluginServices(),
        readHookEventEnvelopeV1,
        dispose: params?.dispose ?? (async () => {}),
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

    it('exposes no arbitrary reload owner and joins concurrent cold acquisitions through one resolver', async () => {
        const deferred = createDeferred<ResolvedExecutablePluginRuntimeRegistry>();
        const registry = createRuntimeRegistry('cold');
        const resolveRuntimeRegistry = vi.fn(async () => await deferred.promise);
        const controller = createPluginReloadController({ resolveRuntimeRegistry });

        const firstLeasePromise = controller.acquireRuntimeRegistry();
        const secondLeasePromise = controller.acquireRuntimeRegistry();

        expect('reload' in controller).toBe(false);
        expect(resolveRuntimeRegistry).toHaveBeenCalledTimes(1);

        deferred.resolve(registry);
        const [firstLease, secondLease] = await Promise.all([firstLeasePromise, secondLeasePromise]);
        expect(firstLease.registry).toBe(registry);
        expect(secondLease.registry).toBe(registry);
        expect(controller.getState()).toMatchObject({
            generation: 1,
            activeRegistry: registry,
            lastResult: {
                ok: true,
                generation: 1,
                registryStatus: 'active',
                registry,
            },
        });

        await firstLease.release();
        await secondLease.release();
        await controller.shutdown();
    });

    it('reuses the initialized registry without resolving again', async () => {
        const registry = createRuntimeRegistry('cold');
        const resolveRuntimeRegistry = vi.fn(async () => registry);
        const controller = createPluginReloadController({ resolveRuntimeRegistry });

        const first = await controller.acquireRuntimeRegistry();
        await first.release();
        const second = await controller.acquireRuntimeRegistry();

        expect(second.registry).toBe(registry);
        expect(resolveRuntimeRegistry).toHaveBeenCalledTimes(1);
        await second.release();
    });

    it('does not publish a cold registry when its pre-publication reconciliation fails', async () => {
        const failure = new Error('purpose reconciliation failed');
        const dispose = vi.fn(async () => {});
        const registry = createRuntimeRegistry('cold', { dispose });
        const controller = createPluginReloadController();
        const beforePublish = vi.fn(async () => {
            expect(controller.getState().activeRegistry).toBeNull();
            throw failure;
        });

        await expect(controller.acquireRuntimeRegistry({
            resolveRuntimeRegistry: async () => registry,
            beforePublish,
        })).rejects.toBe(failure);

        expect(beforePublish).toHaveBeenCalledWith(registry, expect.any(Function));
        expect(controller.getState()).toMatchObject({
            generation: 0,
            activeRegistry: null,
        });
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('publishes a cold candidate synchronously inside the pre-publication writer fence', async () => {
        const registry = createRuntimeRegistry('cold');
        const controller = createPluginReloadController();
        const beforePublish = vi.fn(async (
            _registry: ResolvedExecutablePluginRuntimeRegistry,
            publish: () => void,
        ) => {
            expect(controller.getState().activeRegistry).toBeNull();
            publish();
            expect(controller.getState().activeRegistry).toBe(registry);
        });

        const lease = await controller.acquireRuntimeRegistry({
            resolveRuntimeRegistry: async () => registry,
            beforePublish,
        });

        expect(beforePublish).toHaveBeenCalledTimes(1);
        expect(lease.registry).toBe(registry);
        await lease.release();
    });

    it('does not publish a cold candidate after shutdown starts during pre-publication reconciliation', async () => {
        const beforePublishEntered = createDeferred<void>();
        const releaseBeforePublish = createDeferred<void>();
        const dispose = vi.fn(async () => {});
        const registry = createRuntimeRegistry('cold-shutdown-race', { dispose });
        const controller = createPluginReloadController();
        const acquisition = controller.acquireRuntimeRegistry({
            resolveRuntimeRegistry: async () => registry,
            beforePublish: async (_registry, publish) => {
                beforePublishEntered.resolve();
                await releaseBeforePublish.promise;
                publish();
            },
        });
        await beforePublishEntered.promise;

        await controller.shutdown({ timeoutMs: 50 });
        releaseBeforePublish.resolve();

        await expect(acquisition).rejects.toThrow(/shut down/i);
        expect(controller.getState().activeRegistry).toBeNull();
        expect(dispose).toHaveBeenCalledOnce();
    });

    it('isolates a cold plugin activation failure without withholding the healthy runtime registry', async () => {
        const dispose = vi.fn(async () => {});
        const registry = createRuntimeRegistry('acme.healthy', {
            additionalPluginDiagnostics: {
                'acme.broken': [{ code: 'plugin_activation_failed', message: 'activation failed' }],
            },
            dispose,
        });
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => registry,
        });
        const observed = vi.fn();
        controller.subscribe(observed);

        const lease = await controller.acquireRuntimeRegistry();
        expect(lease.registry).toBe(registry);
        expect(controller.getState()).toMatchObject({
            generation: 1,
            activeRegistry: registry,
            lastResult: {
                ok: true,
                registryStatus: 'active',
                diagnosticsByPluginId: registry.pluginDiagnosticsByPluginId,
            },
        });
        expect(observed).toHaveBeenCalledWith(expect.objectContaining({
            ok: true,
            registryStatus: 'active',
            diagnosticsByPluginId: registry.pluginDiagnosticsByPluginId,
        }));
        expect(dispose).not.toHaveBeenCalled();

        await lease.release();
        await controller.shutdown();
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('allows trust-only diagnostics during cold restart initialization', async () => {
        const registry = createRuntimeRegistry('healthy.plugin', {
            additionalPluginDiagnostics: {
                'untrusted.plugin': [
                    { code: 'plugin_untrusted', message: 'Untrusted' },
                    { code: 'plugin_trust_approval_required', message: 'Approval required' },
                ],
            },
        });
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => registry,
        });

        const lease = await controller.acquireRuntimeRegistry();
        expect(lease.registry).toBe(registry);
        expect(controller.getState().activeRegistry).toBe(registry);
        await lease.release();
    });

    it('can retry cold initialization after the resolver rejects', async () => {
        const registry = createRuntimeRegistry('recovered');
        const resolveRuntimeRegistry = vi.fn()
            .mockRejectedValueOnce(new Error('cold failure'))
            .mockResolvedValueOnce(registry);
        const controller = createPluginReloadController({ resolveRuntimeRegistry });

        await expect(controller.acquireRuntimeRegistry()).rejects.toThrow('cold failure');
        const lease = await controller.acquireRuntimeRegistry();

        expect(lease.registry).toBe(registry);
        expect(resolveRuntimeRegistry).toHaveBeenCalledTimes(2);
        await lease.release();
    });

    it('adopts a prepared registry without resolving it again or waiting for predecessor cleanup', async () => {
        const cleanupStarted = createDeferred<void>();
        const allowCleanup = createDeferred<void>();
        const initialRegistry = createRuntimeRegistry('initial', {
            dispose: async () => {
                cleanupStarted.resolve();
                await allowCleanup.promise;
            },
        });
        const preparedRegistry = createRuntimeRegistry('prepared', {
            generationId: 'registry:prepared',
        });
        const resolveRuntimeRegistry = vi.fn(async () => initialRegistry);
        const controller = createPluginReloadController({ resolveRuntimeRegistry });
        const initialLease = await controller.acquireRuntimeRegistry();
        await initialLease.release();

        const adopted = await controller.adoptPreparedRuntimeRegistry({
            registry: preparedRegistry,
            changedPluginIds: [' acme.plugin ', 'acme.plugin'],
            durableRevision: 1,
        });

        expect(adopted).toMatchObject({
            ok: true,
            generation: 2,
            activeGenerationId: 'registry:prepared',
            registry: preparedRegistry,
            changedPluginIds: ['acme.plugin'],
        });
        expect(controller.getState().activeRegistry).toBe(preparedRegistry);
        expect(resolveRuntimeRegistry).toHaveBeenCalledTimes(1);
        await cleanupStarted.promise;
        allowCleanup.resolve();
    });

    it('keeps prepared registry adoption monotonic by durable desired revision', async () => {
        const revisionOne = createRuntimeRegistry('revision-one');
        const revisionTwo = createRuntimeRegistry('revision-two');
        const staleRevisionOne = createRuntimeRegistry('stale-revision-one');
        const duplicateRevisionTwo = createRuntimeRegistry('duplicate-revision-two');
        const controller = createPluginReloadController();

        await expect(controller.adoptPreparedRuntimeRegistry({
            registry: revisionOne,
            changedPluginIds: ['acme.first'],
            durableRevision: 1,
        })).resolves.toMatchObject({ generation: 1, registry: revisionOne });
        await expect(controller.adoptPreparedRuntimeRegistry({
            registry: revisionTwo,
            changedPluginIds: ['acme.second'],
            durableRevision: 2,
        })).resolves.toMatchObject({ generation: 2, registry: revisionTwo });

        await expect(controller.adoptPreparedRuntimeRegistry({
            registry: staleRevisionOne,
            changedPluginIds: ['acme.first'],
            durableRevision: 1,
        })).rejects.toThrow(/not newer than observed revision 2/i);
        await expect(controller.adoptPreparedRuntimeRegistry({
            registry: duplicateRevisionTwo,
            changedPluginIds: ['acme.second'],
            durableRevision: 2,
        })).rejects.toThrow(/not newer than observed revision 2/i);

        expect(controller.getState()).toMatchObject({
            generation: 2,
            activeRegistry: revisionTwo,
            lastResult: { generation: 2, registry: revisionTwo },
        });
        expect(controller.isRuntimeRegistryCurrent(revisionTwo)).toBe(true);
    });

    it('keeps unrelated plugin admission live and publishes a higher revision while a lower revision awaits reconciliation', async () => {
        const lowerEntered = createDeferred<void>();
        const releaseLower = createDeferred<void>();
        const lowerRetired = vi.fn();
        const lowerRegistry = createRuntimeRegistry('revision-two');
        const higherRegistry = createRuntimeRegistry('revision-three');
        const initialRegistry = createRuntimeRegistry('revision-one', {
            retirePluginConsumers: lowerRetired,
        });
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => initialRegistry,
        });
        const publishHigher = vi.fn();
        const initialLease = await controller.acquireRuntimeRegistry();
        await initialLease.release();

        const lowerAdoption = controller.adoptPreparedRuntimeRegistry({
            registry: lowerRegistry,
            changedPluginIds: ['acme.lower'],
            durableRevision: 2,
            beforePublish: async (_registry, publish) => {
                lowerEntered.resolve();
                await releaseLower.promise;
                publish();
            },
        });
        await lowerEntered.promise;

        const unrelatedLease = controller.tryAcquireRuntimeRegistry?.();
        expect(unrelatedLease?.registry).toBe(initialRegistry);
        await unrelatedLease?.release();

        const higherAdoption = controller.adoptPreparedRuntimeRegistry({
            registry: higherRegistry,
            changedPluginIds: ['acme.higher'],
            durableRevision: 3,
            beforePublish: async (_registry, publish) => {
                publishHigher();
                publish();
            },
        });
        await Promise.resolve();
        await Promise.resolve();

        await expect(higherAdoption).resolves.toMatchObject({
            generation: 2,
            registry: higherRegistry,
        });
        expect(publishHigher).toHaveBeenCalledOnce();
        expect(controller.getState().activeRegistry).toBe(higherRegistry);
        expect(lowerRetired).toHaveBeenCalledWith(['acme.higher']);

        releaseLower.resolve();
        await expect(lowerAdoption).rejects.toThrow(/newer durable revision 3/i);
        expect(controller.getState()).toMatchObject({
            generation: 2,
            activeRegistry: higherRegistry,
            lastResult: { generation: 2, registry: higherRegistry },
        });
    });

    it('does not publish an older revision after a newer observed revision fails before publication', async () => {
        const lowerEntered = createDeferred<void>();
        const releaseLower = createDeferred<void>();
        const higherEntered = createDeferred<void>();
        const releaseHigher = createDeferred<void>();
        const retireInitialPluginConsumers = vi.fn();
        const disposeLower = vi.fn(async () => {});
        const disposeHigher = vi.fn(async () => {});
        const initialRegistry = createRuntimeRegistry('revision-one', {
            retirePluginConsumers: retireInitialPluginConsumers,
        });
        const lowerRegistry = createRuntimeRegistry('revision-two', { dispose: disposeLower });
        const higherRegistry = createRuntimeRegistry('revision-three', { dispose: disposeHigher });
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => initialRegistry,
        });
        const initialLease = await controller.acquireRuntimeRegistry();
        await initialLease.release();

        const lowerAdoption = controller.adoptPreparedRuntimeRegistry({
            registry: lowerRegistry,
            changedPluginIds: ['acme.lower'],
            durableRevision: 2,
            beforePublish: async (_registry, publish) => {
                lowerEntered.resolve();
                await releaseLower.promise;
                publish();
            },
        });
        await lowerEntered.promise;

        const higherFailure = new Error('newer pre-publication projection failed');
        const higherAdoption = controller.adoptPreparedRuntimeRegistry({
            registry: higherRegistry,
            changedPluginIds: ['acme.higher'],
            durableRevision: 3,
            beforePublish: async () => {
                higherEntered.resolve();
                await releaseHigher.promise;
                throw higherFailure;
            },
        });
        await higherEntered.promise;

        expect(retireInitialPluginConsumers.mock.calls).toEqual([
            [['acme.lower']],
            [['acme.higher']],
        ]);
        const leaseWhileBothPending = controller.tryAcquireRuntimeRegistry?.();
        expect(leaseWhileBothPending?.registry).toBe(initialRegistry);
        await leaseWhileBothPending?.release();

        releaseHigher.resolve();
        await expect(higherAdoption).rejects.toBe(higherFailure);
        expect(controller.getState().activeRegistry).toBe(initialRegistry);

        releaseLower.resolve();
        await expect(lowerAdoption).rejects.toThrow(/newer durable revision 3/i);
        expect(controller.getState()).toMatchObject({
            generation: 1,
            activeRegistry: initialRegistry,
        });
        expect(disposeHigher).toHaveBeenCalledOnce();
        expect(disposeLower).toHaveBeenCalledOnce();
    });

    it('reserves a newer revision before awaiting cold initialization and fences its changed consumers', async () => {
        const lowerEntered = createDeferred<void>();
        const releaseLower = createDeferred<void>();
        const coldEntered = createDeferred<void>();
        const releaseCold = createDeferred<void>();
        const higherEntered = createDeferred<void>();
        const releaseHigher = createDeferred<void>();
        const retireColdConsumers = vi.fn();
        const retireColdPluginConsumers = vi.fn();
        const disposeLower = vi.fn(async () => {});
        const lowerRegistry = createRuntimeRegistry('revision-two', { dispose: disposeLower });
        const coldRegistry = createRuntimeRegistry('cold', {
            retireConsumers: retireColdConsumers,
            retirePluginConsumers: retireColdPluginConsumers,
        });
        const higherRegistry = createRuntimeRegistry('revision-three');
        const controller = createPluginReloadController();

        const lowerAdoption = controller.adoptPreparedRuntimeRegistry({
            registry: lowerRegistry,
            changedPluginIds: ['acme.lower'],
            durableRevision: 2,
            beforePublish: async (_registry, publish) => {
                lowerEntered.resolve();
                await releaseLower.promise;
                publish();
            },
        });
        await lowerEntered.promise;

        const coldAcquisition = controller.acquireRuntimeRegistry({
            resolveRuntimeRegistry: async () => coldRegistry,
            beforePublish: async (_registry, publish) => {
                coldEntered.resolve();
                await releaseCold.promise;
                publish();
            },
        });
        await coldEntered.promise;

        const higherAdoption = controller.adoptPreparedRuntimeRegistry({
            registry: higherRegistry,
            changedPluginIds: ['acme.higher'],
            durableRevision: 3,
            beforePublish: async (_registry, publish) => {
                higherEntered.resolve();
                await releaseHigher.promise;
                publish();
            },
        });

        releaseLower.resolve();
        await expect(lowerAdoption).rejects.toThrow(/newer durable revision 3/i);
        expect(disposeLower).toHaveBeenCalledOnce();
        expect(controller.getState().activeRegistry).toBeNull();

        releaseCold.resolve();
        const coldLease = await coldAcquisition;
        await higherEntered.promise;
        expect(coldLease.registry).toBe(coldRegistry);
        expect(retireColdPluginConsumers).toHaveBeenCalledExactlyOnceWith(['acme.higher']);
        expect(retireColdConsumers).not.toHaveBeenCalled();
        const unrelatedLease = controller.tryAcquireRuntimeRegistry?.();
        expect(unrelatedLease?.registry).toBe(coldRegistry);
        await unrelatedLease?.release();

        releaseHigher.resolve();
        await expect(higherAdoption).resolves.toMatchObject({
            generation: 2,
            registry: higherRegistry,
        });
        await coldLease.release();
    });

    it('does not publish a prepared registry when pre-publication reconciliation fails', async () => {
        const failure = new Error('purpose reconciliation failed');
        const retireInitialConsumers = vi.fn();
        const retireInitialPluginConsumers = vi.fn();
        const initialRegistry = createRuntimeRegistry('initial', {
            retireConsumers: retireInitialConsumers,
            retirePluginConsumers: retireInitialPluginConsumers,
        });
        const disposePrepared = vi.fn(async () => {});
        const preparedRegistry = createRuntimeRegistry('prepared', {
            dispose: disposePrepared,
        });
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => initialRegistry,
        });
        const initialLease = await controller.acquireRuntimeRegistry();
        await initialLease.release();
        const beforePublish = vi.fn(async () => {
            expect(controller.getState().activeRegistry).toBe(initialRegistry);
            throw failure;
        });

        await expect(controller.adoptPreparedRuntimeRegistry({
            registry: preparedRegistry,
            changedPluginIds: ['acme.plugin'],
            durableRevision: 1,
            beforePublish,
        })).rejects.toBe(failure);

        const immediateLease = controller.tryAcquireRuntimeRegistry?.() ?? null;
        const immediateRegistry = immediateLease?.registry ?? null;
        await immediateLease?.release();
        const acquisitionOutcome = await controller.acquireRuntimeRegistry().then(
            async (lease) => {
                await lease.release();
                return 'resolved' as const;
            },
            (error: unknown) => error,
        );

        expect(beforePublish).toHaveBeenCalledWith(preparedRegistry, expect.any(Function));
        expect(controller.getState()).toMatchObject({
            generation: 1,
            activeRegistry: initialRegistry,
        });
        expect(controller.isRuntimeRegistryCurrent(initialRegistry)).toBe(true);
        expect(immediateRegistry).toBe(initialRegistry);
        expect(acquisitionOutcome).toBe('resolved');
        expect(retireInitialConsumers).not.toHaveBeenCalled();
        expect(retireInitialPluginConsumers).toHaveBeenCalledExactlyOnceWith(['acme.plugin']);
        expect(disposePrepared).toHaveBeenCalledTimes(1);
    });

    it('retires only changed-plugin consumers when publishing a prepared candidate', async () => {
        const retireInitialConsumers = vi.fn();
        const retireInitialPluginConsumers = vi.fn();
        const initialRegistry = createRuntimeRegistry('initial', {
            retireConsumers: retireInitialConsumers,
            retirePluginConsumers: retireInitialPluginConsumers,
        });
        const preparedRegistry = createRuntimeRegistry('prepared');
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => initialRegistry,
        });
        const initialLease = await controller.acquireRuntimeRegistry();
        await initialLease.release();
        const beforePublish = vi.fn(async (
            _registry: ResolvedExecutablePluginRuntimeRegistry,
            publish: () => void,
        ) => {
            expect(controller.getState().activeRegistry).toBe(initialRegistry);
            publish();
            expect(retireInitialConsumers).not.toHaveBeenCalled();
            expect(retireInitialPluginConsumers).toHaveBeenCalledWith(['acme.plugin']);
            expect(controller.getState().activeRegistry).toBe(preparedRegistry);
        });

        await controller.adoptPreparedRuntimeRegistry({
            registry: preparedRegistry,
            changedPluginIds: ['acme.plugin'],
            durableRevision: 1,
            beforePublish,
        });

        expect(beforePublish).toHaveBeenCalledTimes(1);
    });

    it('does not publish a prepared candidate after shutdown starts during pre-publication reconciliation', async () => {
        const beforePublishEntered = createDeferred<void>();
        const releaseBeforePublish = createDeferred<void>();
        const dispose = vi.fn(async () => {});
        const registry = createRuntimeRegistry('prepared-shutdown-race', { dispose });
        const controller = createPluginReloadController();
        const adoption = controller.adoptPreparedRuntimeRegistry({
            registry,
            changedPluginIds: ['acme.plugin'],
            durableRevision: 1,
            beforePublish: async (_registry, publish) => {
                beforePublishEntered.resolve();
                await releaseBeforePublish.promise;
                publish();
            },
        });
        await beforePublishEntered.promise;

        await controller.shutdown({ timeoutMs: 50 });
        releaseBeforePublish.resolve();

        await expect(adoption).rejects.toThrow(/shut down/i);
        expect(controller.getState().activeRegistry).toBeNull();
        expect(dispose).toHaveBeenCalledOnce();
    });

    it('waits for cold initialization before adopting a prepared registry', async () => {
        const coldDeferred = createDeferred<ResolvedExecutablePluginRuntimeRegistry>();
        const coldRegistry = createRuntimeRegistry('cold');
        const preparedRegistry = createRuntimeRegistry('prepared');
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => await coldDeferred.promise,
        });
        const coldLeasePromise = controller.acquireRuntimeRegistry();
        let adoptionSettled = false;
        const adoption = controller.adoptPreparedRuntimeRegistry({
            registry: preparedRegistry,
            changedPluginIds: ['acme.plugin'],
            durableRevision: 1,
        }).then((result) => {
            adoptionSettled = true;
            return result;
        });

        await Promise.resolve();
        expect(adoptionSettled).toBe(false);
        coldDeferred.resolve(coldRegistry);

        const coldLease = await coldLeasePromise;
        await expect(adoption).resolves.toMatchObject({ generation: 2, registry: preparedRegistry });
        expect(coldLease.registry).toBe(coldRegistry);
        expect(controller.getState().activeRegistry).toBe(preparedRegistry);
        await coldLease.release();
    });

    it('does not make a prepared publication a global cold-initialization barrier', async () => {
        const preparedEntered = createDeferred<void>();
        const releasePrepared = createDeferred<void>();
        const preparedRegistry = createRuntimeRegistry('prepared');
        const coldRegistry = createRuntimeRegistry('cold');
        const resolveRuntimeRegistry = vi.fn(async () => coldRegistry);
        const controller = createPluginReloadController({ resolveRuntimeRegistry });
        const adoption = controller.adoptPreparedRuntimeRegistry({
            registry: preparedRegistry,
            changedPluginIds: ['acme.plugin'],
            durableRevision: 1,
            beforePublish: async (_registry, publish) => {
                preparedEntered.resolve();
                await releasePrepared.promise;
                publish();
            },
        });
        await preparedEntered.promise;

        const acquisition = controller.acquireRuntimeRegistry();
        await Promise.resolve();
        await Promise.resolve();
        const resolveCallsBeforePreparedPublication = resolveRuntimeRegistry.mock.calls.length;

        const coldLease = await acquisition;
        expect(coldLease.registry).toBe(coldRegistry);
        expect(resolveCallsBeforePreparedPublication).toBe(1);

        releasePrepared.resolve();
        await expect(adoption).resolves.toMatchObject({
            generation: 2,
            registry: preparedRegistry,
        });
        expect(controller.getState().activeRegistry).toBe(preparedRegistry);
        await coldLease.release();
    });

    it('fences changed predecessor consumers while keeping the aggregate registry available before publication', async () => {
        const preparedEntered = createDeferred<void>();
        const releasePrepared = createDeferred<void>();
        const retireInitialPluginConsumers = vi.fn();
        const initialRegistry = createRuntimeRegistry('initial', {
            retirePluginConsumers: retireInitialPluginConsumers,
        });
        const preparedRegistry = createRuntimeRegistry('prepared');
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => initialRegistry,
        });
        const initialLease = await controller.acquireRuntimeRegistry();
        await initialLease.release();

        const adoption = controller.adoptPreparedRuntimeRegistry({
            registry: preparedRegistry,
            changedPluginIds: ['acme.plugin'],
            durableRevision: 1,
            beforePublish: async (_registry, publish) => {
                preparedEntered.resolve();
                await releasePrepared.promise;
                publish();
            },
        });
        await preparedEntered.promise;

        const immediateLease = controller.tryAcquireRuntimeRegistry?.() ?? null;
        const immediateRegistry = immediateLease?.registry ?? null;
        await immediateLease?.release();
        const predecessorCurrentDuringAdoption =
            controller.isRuntimeRegistryCurrent(initialRegistry);

        const leaseDuringReconciliation = await controller.acquireRuntimeRegistry();

        expect(retireInitialPluginConsumers).toHaveBeenCalledExactlyOnceWith(['acme.plugin']);
        releasePrepared.resolve();
        await expect(adoption).resolves.toMatchObject({ registry: preparedRegistry });

        expect(immediateRegistry).toBe(initialRegistry);
        expect(predecessorCurrentDuringAdoption).toBe(true);
        expect(leaseDuringReconciliation.registry).toBe(initialRegistry);
        expect(controller.isRuntimeRegistryCurrent(preparedRegistry)).toBe(true);
        await leaseDuringReconciliation.release();
    });

    it('allows an independent prepared publication to proceed while an earlier adoption fails', async () => {
        const firstEntered = createDeferred<void>();
        const releaseFirst = createDeferred<void>();
        const secondEntered = createDeferred<void>();
        const releaseSecond = createDeferred<void>();
        const firstRegistry = createRuntimeRegistry('first');
        const secondRegistry = createRuntimeRegistry('second');
        const coldRegistry = createRuntimeRegistry('cold');
        const resolveRuntimeRegistry = vi.fn(async () => coldRegistry);
        const controller = createPluginReloadController({ resolveRuntimeRegistry });
        const firstFailure = new Error('first publication failed');
        const firstAdoption = controller.adoptPreparedRuntimeRegistry({
            registry: firstRegistry,
            changedPluginIds: ['acme.plugin'],
            durableRevision: 1,
            beforePublish: async () => {
                firstEntered.resolve();
                await releaseFirst.promise;
                throw firstFailure;
            },
        });
        await firstEntered.promise;

        const acquisition = controller.acquireRuntimeRegistry();
        const secondAdoption = controller.adoptPreparedRuntimeRegistry({
            registry: secondRegistry,
            changedPluginIds: ['acme.plugin'],
            durableRevision: 2,
            beforePublish: async (_registry, publish) => {
                secondEntered.resolve();
                await releaseSecond.promise;
                publish();
            },
        });
        await secondEntered.promise;

        releaseSecond.resolve();
        await expect(secondAdoption).resolves.toMatchObject({ registry: secondRegistry });
        releaseFirst.resolve();
        await expect(firstAdoption).rejects.toBe(firstFailure);
        const lease = await acquisition;
        expect(lease.registry).toBe(coldRegistry);
        expect(resolveRuntimeRegistry).toHaveBeenCalledOnce();
        expect(controller.getState().activeRegistry).toBe(secondRegistry);
        await lease.release();
    });

    it('keeps a predecessor registry alive until every outstanding lease is released', async () => {
        const disposeInitial = vi.fn(async () => {});
        const initialRegistry = createRuntimeRegistry('initial', { dispose: disposeInitial });
        const preparedRegistry = createRuntimeRegistry('prepared');
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => initialRegistry,
        });
        const firstLease = await controller.acquireRuntimeRegistry();
        const secondLease = await controller.acquireRuntimeRegistry();

        await controller.adoptPreparedRuntimeRegistry({
            registry: preparedRegistry,
            changedPluginIds: ['acme.plugin'],
            durableRevision: 1,
        });
        expect(disposeInitial).not.toHaveBeenCalled();

        await firstLease.release();
        expect(disposeInitial).not.toHaveBeenCalled();
        await secondLease.release();
        expect(disposeInitial).toHaveBeenCalledTimes(1);
    });

    it('rejects and disposes a prepared registry with blocking diagnostics', async () => {
        const retireInitialConsumers = vi.fn();
        const retireInitialPluginConsumers = vi.fn();
        const initialRegistry = createRuntimeRegistry('initial', {
            retireConsumers: retireInitialConsumers,
            retirePluginConsumers: retireInitialPluginConsumers,
        });
        const dispose = vi.fn(async () => {});
        const registry = createRuntimeRegistry('acme.broken', {
            diagnostics: [{ code: 'plugin_daemon_module_load_failed', message: 'load failed' }],
            dispose,
        });
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => initialRegistry,
        });
        const initialLease = await controller.acquireRuntimeRegistry();
        await initialLease.release();

        await expect(controller.adoptPreparedRuntimeRegistry({
            registry,
            changedPluginIds: ['acme.broken'],
            durableRevision: 1,
        })).rejects.toThrow(/blocking activation diagnostic/i);
        const afterFailure = await controller.acquireRuntimeRegistry();
        expect(afterFailure.registry).toBe(initialRegistry);
        await afterFailure.release();
        expect(controller.getState().activeRegistry).toBe(initialRegistry);
        expect(controller.isRuntimeRegistryCurrent(initialRegistry)).toBe(true);
        expect(retireInitialConsumers).not.toHaveBeenCalled();
        expect(retireInitialPluginConsumers).toHaveBeenCalledExactlyOnceWith(['acme.broken']);
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('notifies listeners once for cold initialization and each prepared adoption', async () => {
        const coldRegistry = createRuntimeRegistry('cold');
        const preparedRegistry = createRuntimeRegistry('prepared');
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => coldRegistry,
        });
        const observed: number[] = [];
        const unsubscribe = controller.subscribe((result) => observed.push(result.generation));

        const lease = await controller.acquireRuntimeRegistry();
        await lease.release();
        await controller.adoptPreparedRuntimeRegistry({
            registry: preparedRegistry,
            changedPluginIds: ['acme.plugin'],
            durableRevision: 1,
        });
        unsubscribe();

        expect(observed).toEqual([1, 2]);
    });

    it('returns a synchronous lease only while an active registry is available', async () => {
        const registry = createRuntimeRegistry('active');
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => registry,
        });

        expect(controller.tryAcquireRuntimeRegistry?.()).toBeNull();
        const coldLease = await controller.acquireRuntimeRegistry();
        await coldLease.release();

        const activeLease = controller.tryAcquireRuntimeRegistry?.();
        expect(activeLease?.registry).toBe(registry);
        await activeLease?.release();
    });

    it('waits for a held registry lease during shutdown before disposing its generation', async () => {
        const dispose = vi.fn(async () => {});
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => createRuntimeRegistry('shutdown-leased', { dispose }),
        });
        const lease = await controller.acquireRuntimeRegistry();

        const shutdown = controller.shutdown({ timeoutMs: 5_000 });
        await Promise.resolve();
        expect(dispose).not.toHaveBeenCalled();

        await lease.release();
        await shutdown;
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(controller.getState().activeRegistry).toBeNull();
    });

    it('bounds shutdown disposal when the active registry hangs', async () => {
        vi.useFakeTimers();
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => createRuntimeRegistry('shutdown-hangs', {
                dispose: async () => await new Promise<void>(() => {}),
            }),
        });
        const lease = await controller.acquireRuntimeRegistry();
        await lease.release();

        let settled = false;
        const shutdown = controller.shutdown({ timeoutMs: 50 }).then(() => {
            settled = true;
        });
        await vi.advanceTimersByTimeAsync(49);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await shutdown;
        expect(settled).toBe(true);
    });

    it('rejects an in-flight cold acquisition and disposes its registry when shutdown wins', async () => {
        const deferred = createDeferred<ResolvedExecutablePluginRuntimeRegistry>();
        const resolutionStarted = createDeferred<void>();
        const dispose = vi.fn(async () => {});
        const controller = createPluginReloadController({
            resolveRuntimeRegistry: async () => {
                resolutionStarted.resolve();
                return await deferred.promise;
            },
        });
        const leasePromise = controller.acquireRuntimeRegistry();
        await resolutionStarted.promise;

        await controller.shutdown({ timeoutMs: 50 });
        deferred.resolve(createRuntimeRegistry('late', { dispose }));

        await expect(leasePromise).rejects.toThrow(/shut down/i);
        expect(dispose).toHaveBeenCalledTimes(1);
        await expect(controller.acquireRuntimeRegistry()).rejects.toThrow(/shut down/i);
    });
});
