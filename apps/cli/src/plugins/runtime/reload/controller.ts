import type { ResolvedExecutablePluginRuntimeRegistry } from '../resolveExecutablePluginRuntimeRegistry';
import {
    writePluginReloadStateSnapshot,
} from './state';

export type PluginRuntimeRegistryLease = Readonly<{
    registry: ResolvedExecutablePluginRuntimeRegistry;
    source: 'active' | 'ephemeral';
    release: () => Promise<void>;
}>;

export type PluginReloadDiagnostic = Readonly<{
    code: 'plugin_reload_failed';
    message: string;
}>;

export type PluginReloadRegistryStatus = 'active' | 'last_known_good';

export type PluginReloadResult = Readonly<
    | {
        ok: true;
        generation: number;
        attemptedGeneration: number;
        requestedPluginIds: readonly string[];
        changedPluginIds: readonly string[];
        affectedPluginIds: readonly string[];
        activeGenerationId: string;
        registryStatus: PluginReloadRegistryStatus;
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
        activeGenerationId: string | null;
        registryStatus: 'unavailable';
        diagnostics: readonly PluginReloadDiagnostic[];
        diagnosticsByPluginId: ResolvedExecutablePluginRuntimeRegistry['pluginDiagnosticsByPluginId'];
        registry: ResolvedExecutablePluginRuntimeRegistry | null;
    }
>;

export type PluginReloadState = Readonly<{
    generation: number;
    activeRegistry: ResolvedExecutablePluginRuntimeRegistry | null;
    lastResult: PluginReloadResult | null;
}>;

export type PluginReloadController = Readonly<{
    reload: (params?: Readonly<{ pluginId?: string | null }>) => Promise<PluginReloadResult>;
    acquireRuntimeRegistry: (params?: Readonly<{
        resolveRuntimeRegistry?: () => Promise<ResolvedExecutablePluginRuntimeRegistry>;
    }>) => Promise<PluginRuntimeRegistryLease>;
    getState: () => PluginReloadState;
}>;

function normalizeAffectedPluginIds(pluginId: string | null | undefined): readonly string[] {
    const normalized = typeof pluginId === 'string' ? pluginId.trim() : '';
    return Object.freeze(normalized.length > 0 ? [normalized] : []);
}

type DeferredPluginReloadResult = Readonly<{
    requestedPluginIds: readonly string[];
    resolve: (value: PluginReloadResult) => void;
    reject: (reason?: unknown) => void;
}>;

type PendingReloadScope = Readonly<{
    reloadAll: boolean;
    pluginIds: ReadonlySet<string>;
}>;

type QueuedReloadBatch = Readonly<{
    scope: PendingReloadScope;
    deferreds: readonly DeferredPluginReloadResult[];
}>;

function createDeferredPluginReloadResult(): Readonly<{
    promise: Promise<PluginReloadResult>;
    deferred: Omit<DeferredPluginReloadResult, 'requestedPluginIds'>;
}> {
    let resolve!: (value: PluginReloadResult) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<PluginReloadResult>((innerResolve, innerReject) => {
        resolve = innerResolve;
        reject = innerReject;
    });
    return {
        promise,
        deferred: {
            resolve,
            reject,
        },
    };
}

function withRequestedPluginIds(
    result: PluginReloadResult,
    requestedPluginIds: readonly string[],
): PluginReloadResult {
    return {
        ...result,
        requestedPluginIds,
    };
}

function createPendingReloadScope(affectedPluginIds: readonly string[]): PendingReloadScope {
    return {
        reloadAll: affectedPluginIds.length === 0,
        pluginIds: new Set(affectedPluginIds),
    };
}

function mergePendingReloadScope(
    scope: PendingReloadScope,
    affectedPluginIds: readonly string[],
): PendingReloadScope {
    if (scope.reloadAll || affectedPluginIds.length === 0) {
        return {
            reloadAll: true,
            pluginIds: new Set<string>(),
        };
    }
    return {
        reloadAll: false,
        pluginIds: new Set([...scope.pluginIds, ...affectedPluginIds]),
    };
}

function materializePendingReloadScope(scope: PendingReloadScope): readonly string[] {
    return scope.reloadAll ? Object.freeze([]) : Object.freeze([...scope.pluginIds].sort());
}

function areAffectedPluginIdsEqual(
    left: readonly string[],
    right: readonly string[],
): boolean {
    if (left.length !== right.length) {
        return false;
    }
    return left.every((value, index) => value === right[index]);
}

function collectRegistryPluginIds(registry: ResolvedExecutablePluginRuntimeRegistry): readonly string[] {
    const pluginIds = new Set<string>();
    for (const contribution of registry.contributes.providers) {
        if (contribution.pluginId) pluginIds.add(contribution.pluginId);
    }
    for (const contribution of registry.contributes.backends) {
        if (contribution.pluginId) pluginIds.add(contribution.pluginId);
    }
    for (const contribution of registry.contributes.actions) {
        if (contribution.pluginId) pluginIds.add(contribution.pluginId);
    }
    for (const contribution of registry.contributes.resources) {
        if (contribution.pluginId) pluginIds.add(contribution.pluginId);
    }
    for (const contribution of registry.contributes.uiDescriptors) {
        if (contribution.pluginId) pluginIds.add(contribution.pluginId);
    }
    for (const target of registry.contributes.activationTargets) {
        pluginIds.add(target.pluginId);
    }
    for (const contribution of registry.contributes.hookRegistrations) {
        pluginIds.add(contribution.pluginId);
    }
    for (const pluginId of Object.keys(registry.pluginDiagnosticsByPluginId)) {
        pluginIds.add(pluginId);
    }
    return Object.freeze([...pluginIds].sort());
}

function resolveChangedPluginIds(
    requestedPluginIds: readonly string[],
    registry: ResolvedExecutablePluginRuntimeRegistry,
): readonly string[] {
    return requestedPluginIds.length > 0 ? requestedPluginIds : collectRegistryPluginIds(registry);
}

function resolveActiveGenerationId(
    registry: ResolvedExecutablePluginRuntimeRegistry | null,
    generation: number,
): string | null {
    if (!registry) {
        return null;
    }
    return registry.contributes.generationId ?? `reload:${generation}`;
}

function hasActivationFailure(registry: ResolvedExecutablePluginRuntimeRegistry): boolean {
    return Object.values(registry.pluginDiagnosticsByPluginId).some((diagnostics) => (
        diagnostics.some((diagnostic) => diagnostic.code === 'plugin_activation_failed')
    ));
}

export function createPluginReloadController(params?: Readonly<{
    happyHomeDir?: string;
    resolveRuntimeRegistry?: () => Promise<ResolvedExecutablePluginRuntimeRegistry>;
    invalidateCaches?: (generation: number) => void;
    dispatchReloadHookEvent?: (params: Readonly<{
        runtimeRegistry: Pick<ResolvedExecutablePluginRuntimeRegistry, 'hookHandlersByHookId' | 'readHookEventEnvelopeV1'>;
        eventId: 'plugin.reload.before' | 'plugin.reload.after';
        payload: Record<string, unknown>;
    }>) => Promise<unknown>;
    publishInstalledManifestProjections?: (params: Readonly<{
        pluginIds: readonly string[];
    }>) => Promise<unknown>;
}>): PluginReloadController {
    let generation = 0;
    let activeRegistry: ResolvedExecutablePluginRuntimeRegistry | null = null;
    let lastResult: PluginReloadResult | null = null;
    let inFlight: Promise<PluginReloadResult> | null = null;
    let activeRequestedPluginIds: readonly string[] = Object.freeze([]);
    let queuedReloadBatch: QueuedReloadBatch | null = null;
    const outstandingLeaseCounts = new Map<ResolvedExecutablePluginRuntimeRegistry, number>();
    const pendingDisposal = new Set<ResolvedExecutablePluginRuntimeRegistry>();

    async function resolveHappyHomeDir(): Promise<string> {
        if (params?.happyHomeDir) {
            return params.happyHomeDir;
        }
        const { configuration } = await import('../../../configuration');
        return configuration.happyHomeDir;
    }

    function shouldPersistReloadState(): boolean {
        return !params?.resolveRuntimeRegistry || typeof params.happyHomeDir === 'string';
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
            return;
        }
        outstandingLeaseCounts.set(registry, currentCount - 1);
    }

    async function disposeRegistryWhenSafe(registry: ResolvedExecutablePluginRuntimeRegistry): Promise<void> {
        if ((outstandingLeaseCounts.get(registry) ?? 0) > 0) {
            pendingDisposal.add(registry);
            return;
        }
        await registry.dispose();
    }

    async function resolveRuntimeRegistry(): Promise<ResolvedExecutablePluginRuntimeRegistry> {
        if (params?.resolveRuntimeRegistry) {
            return await params.resolveRuntimeRegistry();
        }
        const { resolveExecutablePluginRuntimeRegistry } = await import('../resolveExecutablePluginRuntimeRegistry');
        return await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir: await resolveHappyHomeDir(),
        });
    }

    async function emitReloadHook(paramsForEvent: Readonly<{
        runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry | null;
        eventId: 'plugin.reload.before' | 'plugin.reload.after';
        payload: Record<string, unknown>;
    }>): Promise<void> {
        if (!params?.dispatchReloadHookEvent || !paramsForEvent.runtimeRegistry) {
            return;
        }
        try {
            await params.dispatchReloadHookEvent({
                runtimeRegistry: paramsForEvent.runtimeRegistry,
                eventId: paramsForEvent.eventId,
                payload: paramsForEvent.payload,
            });
        } catch {
            // Reload lifecycle hooks remain best-effort even if the dispatcher fails.
        }
    }

    async function publishInstalledManifestProjections(pluginIds: readonly string[]): Promise<void> {
        if (!params?.publishInstalledManifestProjections) {
            return;
        }
        try {
            await params.publishInstalledManifestProjections({ pluginIds });
        } catch {
            // Installed-manifest projection sync is best-effort; reload success remains authoritative locally.
        }
    }

    async function runReload(affectedPluginIds: readonly string[]): Promise<PluginReloadResult> {
        const attemptedGeneration = generation + 1;
        if (params?.dispatchReloadHookEvent && activeRegistry) {
            await emitReloadHook({
                runtimeRegistry: activeRegistry,
                eventId: 'plugin.reload.before',
                payload: {
                    affectedPluginIds,
                    attemptedGeneration,
                    currentGeneration: generation,
                    currentGenerationId: resolveActiveGenerationId(activeRegistry, generation),
                },
            });
        }
        try {
            const registry = await resolveRuntimeRegistry();
            const changedPluginIds = resolveChangedPluginIds(affectedPluginIds, registry);
            if (hasActivationFailure(registry)) {
                if (!activeRegistry) {
                    lastResult = {
                        ok: false,
                        generation,
                        attemptedGeneration,
                        requestedPluginIds: affectedPluginIds,
                        changedPluginIds,
                        affectedPluginIds: changedPluginIds,
                        activeGenerationId: null,
                        registryStatus: 'unavailable',
                        diagnostics: Object.freeze([
                            {
                                code: 'plugin_reload_failed',
                                message: 'Plugin activation failed and no active last-known-good registry is available',
                            },
                        ]),
                        diagnosticsByPluginId: registry.pluginDiagnosticsByPluginId,
                        registry: null,
                    };
                    await registry.dispose();
                    return lastResult;
                }

                await registry.dispose();
                lastResult = {
                    ok: true,
                    generation,
                    attemptedGeneration,
                    requestedPluginIds: affectedPluginIds,
                    changedPluginIds,
                    affectedPluginIds: changedPluginIds,
                    activeGenerationId: resolveActiveGenerationId(activeRegistry, generation) ?? `reload:${generation}`,
                    registryStatus: 'last_known_good',
                    diagnostics: Object.freeze([]),
                    diagnosticsByPluginId: registry.pluginDiagnosticsByPluginId,
                    registry: activeRegistry,
                };
                await emitReloadHook({
                    runtimeRegistry: lastResult.registry,
                    eventId: 'plugin.reload.after',
                    payload: {
                        affectedPluginIds: lastResult.affectedPluginIds,
                        changedPluginIds: lastResult.changedPluginIds,
                        generation: lastResult.generation,
                        attemptedGeneration: lastResult.attemptedGeneration,
                        activeGenerationId: lastResult.activeGenerationId,
                        registryStatus: lastResult.registryStatus,
                    },
                });
                return lastResult;
            }

            const previousRegistry = activeRegistry;
            generation = attemptedGeneration;
            activeRegistry = registry;
            params?.invalidateCaches?.(generation);
            if (previousRegistry && previousRegistry !== registry) {
                await disposeRegistryWhenSafe(previousRegistry);
            }
            lastResult = {
                ok: true,
                generation,
                attemptedGeneration,
                requestedPluginIds: affectedPluginIds,
                changedPluginIds,
                affectedPluginIds: changedPluginIds,
                activeGenerationId: resolveActiveGenerationId(registry, generation) ?? `reload:${generation}`,
                registryStatus: 'active',
                diagnostics: Object.freeze([]),
                diagnosticsByPluginId: registry.pluginDiagnosticsByPluginId,
                registry,
            };
            if (shouldPersistReloadState()) {
                await writePluginReloadStateSnapshot(await resolveHappyHomeDir(), {
                    t: 'happier_plugin_reload_state_v1',
                    schemaVersion: 1,
                    generation,
                    activeGenerationId: lastResult.activeGenerationId,
                    changedPluginIds,
                    updatedAt: Date.now(),
                });
            }
            await publishInstalledManifestProjections(affectedPluginIds);
            await emitReloadHook({
                runtimeRegistry: lastResult.registry,
                eventId: 'plugin.reload.after',
                payload: {
                    affectedPluginIds: lastResult.affectedPluginIds,
                    changedPluginIds: lastResult.changedPluginIds,
                    generation: lastResult.generation,
                    attemptedGeneration: lastResult.attemptedGeneration,
                    activeGenerationId: lastResult.activeGenerationId,
                    registryStatus: lastResult.registryStatus,
                },
            });
            return lastResult;
        } catch (error) {
            const diagnostics = Object.freeze([
                {
                    code: 'plugin_reload_failed' as const,
                    message: error instanceof Error ? error.message : 'Plugin reload failed',
                },
            ]);
            if (activeRegistry) {
                lastResult = {
                    ok: true,
                    generation,
                    attemptedGeneration,
                    requestedPluginIds: affectedPluginIds,
                    changedPluginIds: affectedPluginIds,
                    affectedPluginIds,
                    activeGenerationId: resolveActiveGenerationId(activeRegistry, generation) ?? `reload:${generation}`,
                    registryStatus: 'last_known_good',
                    diagnostics,
                    diagnosticsByPluginId: Object.freeze({}),
                    registry: activeRegistry,
                };
                await emitReloadHook({
                    runtimeRegistry: lastResult.registry,
                    eventId: 'plugin.reload.after',
                    payload: {
                        affectedPluginIds: lastResult.affectedPluginIds,
                        changedPluginIds: lastResult.changedPluginIds,
                        generation: lastResult.generation,
                        attemptedGeneration: lastResult.attemptedGeneration,
                        activeGenerationId: lastResult.activeGenerationId,
                        registryStatus: lastResult.registryStatus,
                        diagnostics,
                    },
                });
                return lastResult;
            }

            lastResult = {
                ok: false,
                generation,
                attemptedGeneration,
                requestedPluginIds: affectedPluginIds,
                changedPluginIds: affectedPluginIds,
                affectedPluginIds,
                activeGenerationId: resolveActiveGenerationId(activeRegistry, generation),
                registryStatus: 'unavailable',
                diagnostics,
                diagnosticsByPluginId: Object.freeze({}),
                registry: activeRegistry,
            };
            return lastResult;
        }
    }

    function flushQueuedReloadBatch(): void {
        const nextBatch = queuedReloadBatch;
        queuedReloadBatch = null;
        if (!nextBatch) {
            return;
        }
        startReloadCycle(materializePendingReloadScope(nextBatch.scope), nextBatch.deferreds);
    }

    function startReloadCycle(
        affectedPluginIds: readonly string[],
        deferreds?: readonly DeferredPluginReloadResult[],
    ): Promise<PluginReloadResult> {
        activeRequestedPluginIds = affectedPluginIds;
        const cyclePromise = runReload(affectedPluginIds);
        inFlight = cyclePromise;
        if (deferreds && deferreds.length > 0) {
            void cyclePromise.then(
                (result) => {
                    for (const deferred of deferreds) {
                        deferred.resolve(withRequestedPluginIds(result, deferred.requestedPluginIds));
                    }
                },
                (error) => {
                    for (const deferred of deferreds) {
                        deferred.reject(error);
                    }
                },
            );
        }
        void cyclePromise.finally(() => {
            if (inFlight === cyclePromise) {
                inFlight = null;
            }
            activeRequestedPluginIds = Object.freeze([]);
            flushQueuedReloadBatch();
        });
        return cyclePromise;
    }

    return {
        reload(paramsForReload) {
            const affectedPluginIds = normalizeAffectedPluginIds(paramsForReload?.pluginId);
            if (inFlight) {
                if (areAffectedPluginIdsEqual(affectedPluginIds, activeRequestedPluginIds)) {
                    return inFlight;
                }
                const { promise, deferred } = createDeferredPluginReloadResult();
                queuedReloadBatch = queuedReloadBatch
                    ? {
                        scope: mergePendingReloadScope(queuedReloadBatch.scope, affectedPluginIds),
                        deferreds: [...queuedReloadBatch.deferreds, {
                            ...deferred,
                            requestedPluginIds: affectedPluginIds,
                        }],
                    }
                    : {
                        scope: createPendingReloadScope(affectedPluginIds),
                        deferreds: [{
                            ...deferred,
                            requestedPluginIds: affectedPluginIds,
                        }],
                    };
                return promise;
            }
            return startReloadCycle(affectedPluginIds);
        },
        async acquireRuntimeRegistry(leaseParams) {
            if (activeRegistry) {
                const leasedRegistry = activeRegistry;
                retainRegistryLease(leasedRegistry);
                return {
                    registry: leasedRegistry,
                    source: 'active',
                    release: async () => {
                        await releaseRegistryLease(leasedRegistry);
                    },
                };
            }
            const registry = leaseParams?.resolveRuntimeRegistry
                ? await leaseParams.resolveRuntimeRegistry()
                : await resolveRuntimeRegistry();
            return {
                registry,
                source: 'ephemeral',
                release: async () => {
                    await registry.dispose();
                },
            };
        },
        getState() {
            return {
                generation,
                activeRegistry,
                lastResult,
            };
        },
    };
}
