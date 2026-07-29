import { logger } from '@/ui/logger';

import type { ResolvedExecutablePluginRuntimeRegistry } from '../resolveExecutablePluginRuntimeRegistry';

export type PluginRuntimeRegistryLease = Readonly<{
    registry: ResolvedExecutablePluginRuntimeRegistry;
    source: 'active' | 'ephemeral';
    release: () => Promise<void>;
}>;

export type PluginRuntimeRegistryBeforePublish = (
    registry: ResolvedExecutablePluginRuntimeRegistry,
    /**
     * Publish exactly once, synchronously, after durable pre-publication work commits and before
     * releasing any writer fence. No awaited or fallible work may follow this call.
     */
    publish: () => void,
) => Promise<void>;

export type PluginReloadDiagnostic = Readonly<{
    code: 'plugin_reload_failed';
    message: string;
}>;

export type PluginReloadResult = Readonly<
    | {
        ok: true;
        generation: number;
        attemptedGeneration: number;
        requestedPluginIds: readonly string[];
        changedPluginIds: readonly string[];
        affectedPluginIds: readonly string[];
        activeGenerationId: string;
        registryStatus: 'active';
        diagnostics: readonly PluginReloadDiagnostic[];
        diagnosticsByPluginId: ResolvedExecutablePluginRuntimeRegistry['pluginDiagnosticsByPluginId'];
        registry: ResolvedExecutablePluginRuntimeRegistry;
    }
    | {
        ok: false;
        generation: number;
        attemptedGeneration: number;
        requestedPluginIds: readonly string[];
        changedPluginIds: readonly string[];
        affectedPluginIds: readonly string[];
        activeGenerationId: null;
        registryStatus: 'unavailable';
        diagnostics: readonly PluginReloadDiagnostic[];
        diagnosticsByPluginId: ResolvedExecutablePluginRuntimeRegistry['pluginDiagnosticsByPluginId'];
        registry: null;
    }
>;

export type PluginReloadState = Readonly<{
    generation: number;
    activeRegistry: ResolvedExecutablePluginRuntimeRegistry | null;
    lastResult: PluginReloadResult | null;
}>;

export type PluginReloadListener = (result: PluginReloadResult) => void;

export type PluginReloadController = Readonly<{
    adoptPreparedRuntimeRegistry: (params: Readonly<{
        registry: ResolvedExecutablePluginRuntimeRegistry;
        changedPluginIds: readonly string[];
        durableRevision: number;
        beforePublish?: PluginRuntimeRegistryBeforePublish;
    }>) => Promise<PluginReloadResult>;
    acquireRuntimeRegistry: (params?: Readonly<{
        resolveRuntimeRegistry?: () => Promise<ResolvedExecutablePluginRuntimeRegistry>;
        beforePublish?: PluginRuntimeRegistryBeforePublish;
    }>) => Promise<PluginRuntimeRegistryLease>;
    tryAcquireRuntimeRegistry?: () => PluginRuntimeRegistryLease | null;
    isRuntimeRegistryCurrent: (registry: ResolvedExecutablePluginRuntimeRegistry) => boolean;
    shutdown: (params?: Readonly<{ timeoutMs?: number }>) => Promise<void>;
    getState: () => PluginReloadState;
    /** Notified after cold initialization or prepared-registry adoption settles. */
    subscribe: (listener: PluginReloadListener) => () => void;
}>;

function collectRegistryPluginIds(registry: ResolvedExecutablePluginRuntimeRegistry): readonly string[] {
    const pluginIds = new Set<string>();
    for (const contribution of registry.contributes.agents) {
        if (contribution.pluginId) pluginIds.add(contribution.pluginId);
    }
    for (const contribution of registry.contributes.providers ?? []) {
        pluginIds.add(contribution.pluginId);
    }
    for (const contribution of registry.contributes.actions) {
        if (contribution.pluginId) pluginIds.add(contribution.pluginId);
    }
    for (const contribution of registry.contributes.resources) {
        if (contribution.pluginId) pluginIds.add(contribution.pluginId);
    }
    for (const target of registry.contributes.activationTargets) {
        pluginIds.add(target.pluginId);
    }
    for (const pluginId of Object.keys(registry.pluginDiagnosticsByPluginId)) {
        pluginIds.add(pluginId);
    }
    return Object.freeze([...pluginIds].sort());
}

function normalizePluginIds(pluginIds: readonly string[]): readonly string[] {
    return Object.freeze([...new Set(pluginIds.map((pluginId) => pluginId.trim()).filter(Boolean))].sort());
}

function resolveActiveGenerationId(
    registry: ResolvedExecutablePluginRuntimeRegistry,
    generation: number,
): string {
    return registry.contributes.generationId ?? `reload:${generation}`;
}

const BLOCKING_PLUGIN_RELOAD_DIAGNOSTIC_CODES = new Set([
    'plugin_activation_failed',
    'plugin_daemon_module_load_failed',
    'plugin_source_missing',
    'plugin_source_kind_unsupported',
    'plugin_trust_approval_required',
    'plugin_untrusted',
]);

const TRUST_POLICY_PLUGIN_RELOAD_DIAGNOSTIC_CODES = new Set([
    'plugin_trust_approval_required',
    'plugin_untrusted',
]);

export function hasBlockingPluginReloadDiagnostic(
    registry: ResolvedExecutablePluginRuntimeRegistry,
    scopedPluginIds: readonly string[],
    options?: Readonly<{ ignoreTrustPolicyDiagnostics?: boolean }>,
): boolean {
    return scopedPluginIds.some((pluginId) => (
        (registry.pluginDiagnosticsByPluginId[pluginId] ?? []).some((diagnostic) => (
            BLOCKING_PLUGIN_RELOAD_DIAGNOSTIC_CODES.has(diagnostic.code)
            && !(options?.ignoreTrustPolicyDiagnostics === true
                && TRUST_POLICY_PLUGIN_RELOAD_DIAGNOSTIC_CODES.has(diagnostic.code))
        ))
    ));
}

function normalizeShutdownTimeoutMs(value: number | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return 5_000;
    }
    return Math.max(0, Math.trunc(value));
}

function createShutdownError(): Error {
    return new Error('Plugin runtime registry has shut down');
}

class ColdInitializationSupersededError extends Error {
    constructor() {
        super('Cold plugin runtime registry initialization was superseded by a prepared registry');
    }
}

export function createPluginReloadController(params?: Readonly<{
    happyHomeDir?: string;
    resolveRuntimeRegistry?: () => Promise<ResolvedExecutablePluginRuntimeRegistry>;
    invalidateCaches?: (generation: number) => void;
}>): PluginReloadController {
    let generation = 0;
    let activeRegistry: ResolvedExecutablePluginRuntimeRegistry | null = null;
    let lastResult: PluginReloadResult | null = null;
    let coldInitializationPromise: Promise<PluginReloadResult> | null = null;
    let shutdownPromise: Promise<void> | null = null;
    let shutdownStarted = false;
    let highestObservedDurableRevision: number | null = null;
    let shutdownTimeoutMs = normalizeShutdownTimeoutMs(undefined);
    const outstandingLeaseCounts = new Map<ResolvedExecutablePluginRuntimeRegistry, number>();
    const pendingDisposal = new Set<ResolvedExecutablePluginRuntimeRegistry>();
    const leaseDrainListeners = new Set<() => void>();
    const reloadListeners = new Set<PluginReloadListener>();

    function notifyReloadListeners(result: PluginReloadResult): void {
        for (const listener of reloadListeners) {
            try {
                listener(result);
            } catch (error) {
                logger.debug('[PLUGIN RUNTIME] Plugin runtime registry listener threw', error);
            }
        }
    }

    async function resolveHappyHomeDir(): Promise<string> {
        if (params?.happyHomeDir) {
            return params.happyHomeDir;
        }
        const { configuration } = await import('../../../configuration');
        return configuration.happyHomeDir;
    }

    function retainRegistryLease(registry: ResolvedExecutablePluginRuntimeRegistry): void {
        outstandingLeaseCounts.set(registry, (outstandingLeaseCounts.get(registry) ?? 0) + 1);
    }

    async function releaseRegistryLease(registry: ResolvedExecutablePluginRuntimeRegistry): Promise<void> {
        const currentCount = outstandingLeaseCounts.get(registry) ?? 0;
        if (currentCount <= 1) {
            outstandingLeaseCounts.delete(registry);
            if (pendingDisposal.has(registry) && registry !== activeRegistry) {
                pendingDisposal.delete(registry);
                await registry.dispose();
            }
        } else {
            outstandingLeaseCounts.set(registry, currentCount - 1);
        }
        for (const listener of leaseDrainListeners) listener();
    }

    function createRuntimeRegistryLease(
        registry: ResolvedExecutablePluginRuntimeRegistry,
    ): PluginRuntimeRegistryLease {
        retainRegistryLease(registry);
        let released = false;
        return {
            registry,
            source: 'active',
            release: async () => {
                if (released) return;
                released = true;
                await releaseRegistryLease(registry);
            },
        };
    }

    async function waitForRegistryLeasesToDrain(
        registries: ReadonlySet<ResolvedExecutablePluginRuntimeRegistry>,
        timeoutMs: number,
    ): Promise<void> {
        const drained = () => [...registries].every(
            (registry) => (outstandingLeaseCounts.get(registry) ?? 0) === 0,
        );
        if (drained()) return;
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        let listener: (() => void) | null = null;
        await Promise.race([
            new Promise<void>((resolve) => {
                listener = () => {
                    if (drained()) resolve();
                };
                leaseDrainListeners.add(listener);
            }),
            new Promise<void>((resolve) => {
                timeoutHandle = setTimeout(resolve, timeoutMs);
                timeoutHandle.unref?.();
            }),
        ]);
        if (listener) leaseDrainListeners.delete(listener);
        if (timeoutHandle) clearTimeout(timeoutHandle);
    }

    async function disposeRegistryWhenSafe(registry: ResolvedExecutablePluginRuntimeRegistry): Promise<void> {
        if ((outstandingLeaseCounts.get(registry) ?? 0) > 0) {
            pendingDisposal.add(registry);
            return;
        }
        await registry.dispose();
    }

    function disposeRegistryWhenSafeInBackground(registry: ResolvedExecutablePluginRuntimeRegistry): void {
        void disposeRegistryWhenSafe(registry).catch((error: unknown) => {
            logger.warn('[PLUGIN RUNTIME] Retiring plugin runtime registry cleanup failed', {
                error: error instanceof Error ? error.message : String(error),
            });
        });
    }

    async function disposeRegistryForShutdown(
        registry: ResolvedExecutablePluginRuntimeRegistry,
        timeoutMs: number,
    ): Promise<void> {
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        const disposePromise = registry.dispose({
            timeoutMs,
            onError: (event) => {
                logger.warn('[PLUGIN RUNTIME] Plugin cleanup failed during daemon shutdown', {
                    pluginId: event.pluginId,
                    phase: event.phase,
                    error: event.error instanceof Error ? event.error.message : String(event.error),
                });
            },
        }).then(
            () => 'disposed' as const,
            (error: unknown) => {
                logger.warn('[PLUGIN RUNTIME] Plugin runtime registry disposal failed during daemon shutdown', {
                    error: error instanceof Error ? error.message : String(error),
                });
                return 'failed' as const;
            },
        );
        const timeoutPromise = new Promise<'timeout'>((resolve) => {
            timeoutHandle = setTimeout(() => resolve('timeout'), timeoutMs);
            timeoutHandle.unref?.();
        });
        const result = await Promise.race([disposePromise, timeoutPromise]);
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (result === 'timeout') {
            logger.warn('[PLUGIN RUNTIME] Plugin runtime registry disposal timed out during daemon shutdown', {
                timeoutMs,
            });
        }
    }

    async function resolveRuntimeRegistry(
        attemptedGeneration: number,
        resolveRuntimeRegistryOverride?: () => Promise<ResolvedExecutablePluginRuntimeRegistry>,
    ): Promise<ResolvedExecutablePluginRuntimeRegistry> {
        const resolver = resolveRuntimeRegistryOverride ?? params?.resolveRuntimeRegistry;
        if (resolver) {
            return await resolver();
        }
        const { resolveExecutablePluginRuntimeRegistry } = await import('../resolveExecutablePluginRuntimeRegistry');
        return await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir: await resolveHappyHomeDir(),
            generation: attemptedGeneration,
        });
    }

    function createActiveResult(
        registry: ResolvedExecutablePluginRuntimeRegistry,
        changedPluginIds: readonly string[],
    ): Extract<PluginReloadResult, { ok: true }> {
        return {
            ok: true,
            generation,
            attemptedGeneration: generation,
            requestedPluginIds: changedPluginIds,
            changedPluginIds,
            affectedPluginIds: changedPluginIds,
            activeGenerationId: resolveActiveGenerationId(registry, generation),
            registryStatus: 'active',
            diagnostics: Object.freeze([]),
            diagnosticsByPluginId: registry.pluginDiagnosticsByPluginId,
            registry,
        };
    }

    async function initializeRuntimeRegistry(
        resolveRuntimeRegistryOverride?: () => Promise<ResolvedExecutablePluginRuntimeRegistry>,
        beforePublish?: PluginRuntimeRegistryBeforePublish,
    ): Promise<PluginReloadResult> {
        const attemptedGeneration = generation + 1;
        let registry: ResolvedExecutablePluginRuntimeRegistry;
        try {
            registry = await resolveRuntimeRegistry(attemptedGeneration, resolveRuntimeRegistryOverride);
        } catch (error) {
            const diagnostic = Object.freeze({
                code: 'plugin_reload_failed' as const,
                message: error instanceof Error ? error.message : 'Plugin runtime registry initialization failed',
            });
            lastResult = {
                ok: false,
                generation,
                attemptedGeneration,
                requestedPluginIds: Object.freeze([]),
                changedPluginIds: Object.freeze([]),
                affectedPluginIds: Object.freeze([]),
                activeGenerationId: null,
                registryStatus: 'unavailable',
                diagnostics: Object.freeze([diagnostic]),
                diagnosticsByPluginId: Object.freeze({}),
                registry: null,
            };
            notifyReloadListeners(lastResult);
            throw error;
        }

        if (shutdownStarted) {
            await disposeRegistryForShutdown(registry, shutdownTimeoutMs);
            throw createShutdownError();
        }

        const changedPluginIds = collectRegistryPluginIds(registry);
        const isolatedFailurePluginIds = changedPluginIds.filter((pluginId) => (
            hasBlockingPluginReloadDiagnostic(registry, [pluginId], {
                ignoreTrustPolicyDiagnostics: true,
            })
        ));
        if (isolatedFailurePluginIds.length > 0) {
            logger.warn('[PLUGIN RUNTIME] Cold startup isolated unavailable plugin activations', {
                pluginIds: isolatedFailurePluginIds,
            });
        }

        let published = false;
        const publish = () => {
            if (published) throw new Error('Plugin runtime registry publication callback was invoked more than once');
            if (shutdownStarted) throw createShutdownError();
            if (activeRegistry) throw new ColdInitializationSupersededError();
            published = true;
            generation = attemptedGeneration;
            activeRegistry = registry;
        };
        try {
            if (beforePublish) await beforePublish(registry, publish);
            else publish();
        } catch (error) {
            if (!published) await disposeRegistryForShutdown(registry, shutdownTimeoutMs);
            if (error instanceof ColdInitializationSupersededError && activeRegistry) {
                return createActiveResult(activeRegistry, []);
            }
            const diagnostic = Object.freeze({
                code: 'plugin_reload_failed' as const,
                message: error instanceof Error ? error.message : 'Plugin runtime registry publication failed',
            });
            lastResult = {
                ok: false,
                generation,
                attemptedGeneration,
                requestedPluginIds: Object.freeze([]),
                changedPluginIds: Object.freeze([]),
                affectedPluginIds: Object.freeze([]),
                activeGenerationId: null,
                registryStatus: 'unavailable',
                diagnostics: Object.freeze([diagnostic]),
                diagnosticsByPluginId: registry.pluginDiagnosticsByPluginId,
                registry: null,
            };
            notifyReloadListeners(lastResult);
            throw error;
        }
        if (!published) {
            await disposeRegistryForShutdown(registry, shutdownTimeoutMs);
            throw new Error('Plugin runtime registry pre-publication owner returned without publishing');
        }
        params?.invalidateCaches?.(generation);
        lastResult = createActiveResult(registry, changedPluginIds);
        notifyReloadListeners(lastResult);
        return lastResult;
    }

    function getOrStartColdInitialization(
        resolveRuntimeRegistryOverride?: () => Promise<ResolvedExecutablePluginRuntimeRegistry>,
        beforePublish?: PluginRuntimeRegistryBeforePublish,
    ): Promise<PluginReloadResult> {
        if (coldInitializationPromise) return coldInitializationPromise;
        const initialization = initializeRuntimeRegistry(
            resolveRuntimeRegistryOverride,
            beforePublish,
        );
        coldInitializationPromise = initialization;
        void initialization.then(
            () => {
                if (coldInitializationPromise === initialization) coldInitializationPromise = null;
            },
            () => {
                if (coldInitializationPromise === initialization) coldInitializationPromise = null;
            },
        );
        return initialization;
    }

    return {
        async adoptPreparedRuntimeRegistry(adoption) {
            if (shutdownStarted) {
                await adoption.registry.dispose();
                throw createShutdownError();
            }

            const changedPluginIds = normalizePluginIds(adoption.changedPluginIds);
            if (
                highestObservedDurableRevision !== null
                && adoption.durableRevision <= highestObservedDurableRevision
            ) {
                await adoption.registry.dispose();
                throw new Error(
                    `Prepared plugin runtime registry durable revision ${adoption.durableRevision} `
                    + `is not newer than observed revision ${highestObservedDurableRevision}`,
                );
            }
            // Durable currentness does not roll back while cold initialization or
            // later publication work is pending or fails.
            highestObservedDurableRevision = adoption.durableRevision;

            const initialization = coldInitializationPromise;
            if (initialization) {
                try {
                    await initialization;
                } catch {
                    // A prepared daemon mutation may recover from failed cold initialization.
                }
            }
            if (shutdownStarted) {
                await adoption.registry.dispose();
                throw createShutdownError();
            }

            const previousRegistry = activeRegistry;
            let published = false;
            const publish = () => {
                if (published) {
                    throw new Error('Plugin runtime registry publication callback was invoked more than once');
                }
                if (shutdownStarted) throw createShutdownError();
                if (
                    adoption.durableRevision !== highestObservedDurableRevision
                ) {
                    throw new Error(
                        `Prepared plugin runtime registry durable revision ${adoption.durableRevision} `
                        + `was superseded by newer durable revision ${highestObservedDurableRevision}`,
                    );
                }
                published = true;
                generation += 1;
                activeRegistry = adoption.registry;
            };
            try {
                if (
                    previousRegistry
                    && changedPluginIds.length > 0
                    && !previousRegistry.retirePluginConsumers
                ) {
                    throw new Error(
                        'Active plugin runtime registry cannot retire changed-plugin consumers',
                    );
                }
                // Once the durable revision has passed monotonic arbitration, its
                // changed predecessor is stale. Fence only those consumers before
                // any candidate validation or awaited publication work, so every
                // post-commit failure remains fail-closed without disturbing peers.
                previousRegistry?.retirePluginConsumers?.(changedPluginIds);
                if (hasBlockingPluginReloadDiagnostic(adoption.registry, changedPluginIds)) {
                    throw new Error(
                        'Prepared plugin runtime registry contains a blocking activation diagnostic',
                    );
                }
                if (adoption.beforePublish) {
                    await adoption.beforePublish(adoption.registry, publish);
                } else {
                    publish();
                }
            } catch (error) {
                if (!published) {
                    await adoption.registry.dispose();
                }
                throw error;
            }
            if (!published) {
                await adoption.registry.dispose();
                throw new Error('Plugin runtime registry pre-publication owner returned without publishing');
            }
            params?.invalidateCaches?.(generation);
            lastResult = createActiveResult(adoption.registry, changedPluginIds);
            notifyReloadListeners(lastResult);
            if (previousRegistry && previousRegistry !== adoption.registry) {
                disposeRegistryWhenSafeInBackground(previousRegistry);
            }
            return lastResult;
        },
        async acquireRuntimeRegistry(leaseParams) {
            if (shutdownStarted) throw createShutdownError();

            if (activeRegistry) return createRuntimeRegistryLease(activeRegistry);

            const result = await getOrStartColdInitialization(
                leaseParams?.resolveRuntimeRegistry,
                leaseParams?.beforePublish,
            );
            if (shutdownStarted) throw createShutdownError();
            if (!result.ok || !activeRegistry) {
                throw new Error(result.diagnostics[0]?.message ?? 'Plugin runtime registry unavailable');
            }
            return createRuntimeRegistryLease(activeRegistry);
        },
        tryAcquireRuntimeRegistry() {
            if (
                shutdownStarted
                || !activeRegistry
            ) return null;
            return createRuntimeRegistryLease(activeRegistry);
        },
        isRuntimeRegistryCurrent(registry) {
            return (
                !shutdownStarted
                && activeRegistry === registry
            );
        },
        async shutdown(shutdownParams) {
            if (shutdownPromise) return await shutdownPromise;
            shutdownPromise = (async () => {
                shutdownStarted = true;
                shutdownTimeoutMs = normalizeShutdownTimeoutMs(shutdownParams?.timeoutMs);
                const registriesToDispose = new Set<ResolvedExecutablePluginRuntimeRegistry>();
                if (activeRegistry) registriesToDispose.add(activeRegistry);
                for (const registry of pendingDisposal) registriesToDispose.add(registry);
                activeRegistry = null;
                pendingDisposal.clear();
                await waitForRegistryLeasesToDrain(registriesToDispose, shutdownTimeoutMs);
                outstandingLeaseCounts.clear();
                for (const registry of registriesToDispose) {
                    // eslint-disable-next-line no-await-in-loop
                    await disposeRegistryForShutdown(registry, shutdownTimeoutMs);
                }
            })();
            return await shutdownPromise;
        },
        getState() {
            return { generation, activeRegistry, lastResult };
        },
        subscribe(listener) {
            reloadListeners.add(listener);
            return () => {
                reloadListeners.delete(listener);
            };
        },
    };
}
