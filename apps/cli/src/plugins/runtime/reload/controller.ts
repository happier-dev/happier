import { logger } from '@/ui/logger';
import type {
    PluginRunningSessionDisposition,
    PluginRunningSessionRevocationScope,
} from '@/plugins/store/registry/currentState';

import type { ResolvedExecutablePluginRuntimeRegistry } from '../resolveExecutablePluginRuntimeRegistry';
import type { ResourceSessionAccessWitness } from '../invocation/services/resources';
import {
    createCurrentGlobalExternalSessionsRouter,
    type CurrentGlobalExternalSessionsRouter,
} from '@/session/external/currentGlobalRouting';
import { projectPluginFailureText } from '../lifecycle/utils';
import {
    createReloadControllerTargetedContributionsService,
    type StableTargetedContributionsOwner,
} from '../invocation/services/targetedContributions';
import type {
    PluginRuntimeOccurrenceId,
    PluginRuntimeSlot,
    PluginRuntimeSlotOccurrence,
} from '../runtimeSlots';
import { pluginSourceCustodyEqual, type PluginSourceCustody } from '../sourceAuthority';
import type { PluginRuntimeActivationRegistryLease } from '../composition/activationAssembly';

export type PluginRuntimeRegistryLease = Readonly<{
    registry: ResolvedExecutablePluginRuntimeRegistry;
    source: 'active' | 'ephemeral';
    /**
     * Existing durable registry revision that established this active serving
     * lease. Consumers that join durable and runtime projections must require
     * the same revision rather than combine two current snapshots.
     */
    durableRevision: number;
    /**
     * Revalidates a mounted caller against the controller's currently published
     * runtime without transferring ownership of the retained registry snapshot.
     */
    resolveCurrentPluginMaterializationRef?: NonNullable<
        ResolvedExecutablePluginRuntimeRegistry['resolveCurrentPluginMaterializationRef']
    >;
    /** Revalidates an exact mediator contribution against the live registry. */
    resolveCurrentMediatorContributionMaterializationRef?: NonNullable<
        ResolvedExecutablePluginRuntimeRegistry['resolveCurrentMediatorContributionMaterializationRef']
    >;
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
        runningSessionDisposition: PluginRunningSessionDisposition | null;
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
        runningSessionDisposition: PluginRunningSessionDisposition | null;
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

export type PluginRunningSessionDispositionEvent = Readonly<{
    durableRevision: number;
    changedPluginIds: readonly string[];
    runningSessionDisposition: PluginRunningSessionDisposition;
    runningSessionRevocationScope?: PluginRunningSessionRevocationScope;
}>;

export function isPluginRunningSessionDispositionTarget(
    event: PluginRunningSessionDispositionEvent,
    target: Readonly<{
        pluginId: string;
        immutableGenerationId: string;
    }>,
): boolean {
    if (event.runningSessionDisposition !== 'revokeRunningSessions') {
        return false;
    }
    const scope = event.runningSessionRevocationScope;
    if (scope) {
        return scope.pluginId === target.pluginId
            && scope.immutableGenerationId
                === target.immutableGenerationId;
    }
    return event.changedPluginIds.includes(target.pluginId);
}

export type PluginRunningSessionDispositionListener = (
    event: PluginRunningSessionDispositionEvent,
) => void;

export type PluginReloadController = Readonly<{
    adoptPreparedRuntimeRegistry: (params: Readonly<{
        registry: ResolvedExecutablePluginRuntimeRegistry;
        changedPluginIds: readonly string[];
        durableRevision?: number;
        /** Process-local development candidates use source revision currentness, never a fake durable revision. */
        isDevelopmentCandidateCurrent?: () => boolean;
        runningSessionDisposition: PluginRunningSessionDisposition;
        beforePublish?: PluginRuntimeRegistryBeforePublish;
    }>) => Promise<PluginReloadResult>;
    acquireRuntimeRegistry: (params?: Readonly<{
        resolveRuntimeRegistry?: () => Promise<ResolvedExecutablePluginRuntimeRegistry>;
        beforePublish?: PluginRuntimeRegistryBeforePublish;
    }>) => Promise<PluginRuntimeRegistryLease>;
    tryAcquireRuntimeRegistry: () => PluginRuntimeRegistryLease | null;
    isRuntimeRegistryCurrent: (registry: ResolvedExecutablePluginRuntimeRegistry) => boolean;
    /** The plugin's stable slot, or null when the plugin is not admitted. */
    readPluginSlot?: (pluginId: string) => PluginRuntimeSlot | null;
    readCurrentPluginOccurrenceId?: (pluginId: string) => PluginRuntimeOccurrenceId | null;
    isPluginOccurrenceCurrent?: (
        pluginId: string,
        occurrenceId: PluginRuntimeOccurrenceId,
    ) => boolean;
    readCurrentPluginSourceCustody?: (pluginId: string) => PluginSourceCustody | null;
    /**
     * What a successor candidate keeps from every serving slot outside
     * `excludedPluginIds`: its occurrence, and its activation component when it
     * has one. Also names the active plugins whose component cannot serve a
     * successor (fenced by a durable commit whose publication failed); a
     * candidate prepares only those again.
     */
    retainServingSlots?: (excludedPluginIds: ReadonlySet<string>) => Readonly<{
        occurrencesByPluginId: ReadonlyMap<string, PluginRuntimeSlotOccurrence>;
        leases: readonly PluginRuntimeActivationRegistryLease[];
        unretainedActivePluginIds: readonly string[];
    }>;
    /** Refreshes projections derived from the current registry without replacing its generation. */
    invalidateRuntimeProjection: () => void;
    /** Applies the Account change carrier's current Session-access proof to every live Resource owner. */
    applyResourceSessionAccessWitness: (params: ResourceSessionAccessWitness) => void;
    shutdown: (params?: Readonly<{ timeoutMs?: number }>) => Promise<void>;
    getState: () => PluginReloadState;
    /** Notified after daemon-owned initialization or prepared-registry adoption settles. */
    subscribe: (listener: PluginReloadListener) => () => void;
    /** The controller-lifetime target-local contribution owner. */
    getTargetedContributionsOwner: () => StableTargetedContributionsOwner;
    /**
     * The controller-lifetime public current-global External Sessions router.
     * Long-lived plugin contexts capture it once and keep resolving whichever
     * registry is published now, so an unchanged plugin that survives a peer
     * Agent replacement never keeps routing into its predecessor generation.
     */
    currentGlobalExternalSessions: CurrentGlobalExternalSessionsRouter;
    /** Publishes the authenticated mutation cause immediately after its durable commit. */
    publishDurableRunningSessionDisposition: (
        event: PluginRunningSessionDispositionEvent,
    ) => void;
    subscribeRunningSessionDisposition: (
        listener: PluginRunningSessionDispositionListener,
    ) => () => void;
}>;

function collectRegistryPluginIds(registry: ResolvedExecutablePluginRuntimeRegistry): readonly string[] {
    const pluginIds = new Set<string>();
    for (const contribution of registry.contributes.agents) {
        if (contribution.pluginId) pluginIds.add(contribution.pluginId);
    }
    for (const contribution of registry.contributes.providers ?? []) {
        pluginIds.add(contribution.pluginId);
    }
    for (const contribution of registry.contributes.roles ?? []) {
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

function resolveActiveGenerationId(generation: number): string {
    return String(generation);
}

const BLOCKING_PLUGIN_RELOAD_DIAGNOSTIC_CODES = new Set([
    'plugin_activation_failed',
    'plugin_daemon_module_load_failed',
    'plugin_source_missing',
    'plugin_source_kind_unsupported',
    'plugin_trust_approval_required',
    'plugin_untrusted',
]);

export function hasBlockingPluginReloadDiagnostic(
    registry: ResolvedExecutablePluginRuntimeRegistry,
    scopedPluginIds: readonly string[],
): boolean {
    return scopedPluginIds.some((pluginId) => (
        (registry.pluginDiagnosticsByPluginId[pluginId] ?? []).some((diagnostic) => (
            BLOCKING_PLUGIN_RELOAD_DIAGNOSTIC_CODES.has(diagnostic.code)
        ))
    ));
}

function normalizeShutdownTimeoutMs(value: number | undefined): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return null;
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
    let controller!: PluginReloadController;
    let targetedContributionsOwner: StableTargetedContributionsOwner | null = null;
    let projectManagedServicesOwner: ReturnType<NonNullable<
        ResolvedExecutablePluginRuntimeRegistry['retainProjectManagedServicesOwner']
    >> | null = null;
    const retainProjectCustody = (registry: ResolvedExecutablePluginRuntimeRegistry): void => {
        const owner = registry.retainProjectManagedServicesOwner?.(projectManagedServicesOwner ?? undefined,
            (pluginId, occurrenceId, sourceCustody) => {
                const current = readServingSlotOccurrence(pluginId);
                return current?.occurrenceId === occurrenceId && current.sourceCustody !== null
                    && pluginSourceCustodyEqual(current.sourceCustody, sourceCustody);
            });
        if (owner) projectManagedServicesOwner = owner;
    };
    // Publication (`activeRegistry = registry`) is already the one atomic swap,
    // so the router reads it rather than owning a second retargeting step.
    const currentGlobalExternalSessions = createCurrentGlobalExternalSessionsRouter(
        () => (shutdownStarted
            ? null
            : activeRegistry?.currentGlobalExternalSessionsTarget ?? null),
    );
    let generation = 0;
    let activeRegistry: ResolvedExecutablePluginRuntimeRegistry | null = null;
    /**
     * The one per-plugin currentness owner: which occurrence serves new
     * admissions. Written only at publication (changed occurrences swap, the
     * rest keep their slot and occurrence objects) and when the serving
     * registry fences an occurrence.
     */
    const slots = new Map<string, { readonly pluginId: string; current: PluginRuntimeSlotOccurrence | null }>();
    let unsubscribeServingRegistryFences: (() => void) | null = null;
    let lastResult: PluginReloadResult | null = null;
    let coldInitializationPromise: Promise<PluginReloadResult> | null = null;
    let shutdownPromise: Promise<void> | null = null;
    let shutdownStarted = false;
    let highestObservedDurableRevision: number | null = null;
    let activeRegistryDurableRevision: number | null = null;
    let shutdownTimeoutMs = normalizeShutdownTimeoutMs(undefined);
    const outstandingLeaseCounts = new Map<ResolvedExecutablePluginRuntimeRegistry, number>();
    const pendingDisposal = new Set<ResolvedExecutablePluginRuntimeRegistry>();
    /**
     * Predecessors retired by a synchronous prepared-registry publication whose
     * adoption completion has not settled yet. This is shutdown custody, not a
     * second disposal coordinator: `shutdown` claims these registries through
     * the same exact-once snapshot as `pendingDisposal`, and every settled
     * adoption transfers its predecessor into the existing lease-safe
     * retirement path. A distinct set is required because `pendingDisposal`
     * membership lets an ordinary last-lease release dispose immediately,
     * which must not happen to a published predecessor while the
     * publication hook is still settling.
     */
    const shutdownCustodyPredecessors = new Set<ResolvedExecutablePluginRuntimeRegistry>();
    let currentResourceSessionAccessWitness: ResourceSessionAccessWitness | null = null;
    const leaseDrainListeners = new Set<() => void>();
    const reloadListeners = new Set<PluginReloadListener>();
    const runningSessionDispositionListeners =
        new Set<PluginRunningSessionDispositionListener>();

    /**
     * Session Resource contexts remain owned by their registry generations.
     * The controller forwards the Account carrier to every lease-held owner;
     * it never reconstructs a Session or Resource inventory.
     */
    function resourceSessionRegistries(): ReadonlySet<ResolvedExecutablePluginRuntimeRegistry> {
        const registries = new Set<ResolvedExecutablePluginRuntimeRegistry>();
        if (activeRegistry) registries.add(activeRegistry);
        for (const registry of pendingDisposal) registries.add(registry);
        // A predecessor under shutdown custody is still lease-held until its
        // adoption settles into the lease-safe retirement path, so its
        // retained Resource contexts must stay reachable here too. The single
        // Set keeps a registry appearing in more than one group from being
        // notified twice.
        for (const registry of shutdownCustodyPredecessors) registries.add(registry);
        return registries;
    }

    function publishSlots(registry: ResolvedExecutablePluginRuntimeRegistry): void {
        unsubscribeServingRegistryFences?.();
        unsubscribeServingRegistryFences = registry.subscribePluginOccurrenceFence?.(
            (pluginId, occurrenceId) => {
                const slot = slots.get(pluginId);
                if (registry === activeRegistry && slot?.current?.occurrenceId === occurrenceId) {
                    slot.current = null;
                }
            },
        ) ?? null;
        for (const pluginId of new Set([
            ...collectRegistryPluginIds(registry),
            ...Object.keys(registry.contributes.occurrenceIdsByPluginId ?? {}),
            ...slots.keys(),
        ])) {
            const occurrenceId = registry.readPluginOccurrenceId?.(pluginId) ?? null;
            const slot = slots.get(pluginId);
            if (!occurrenceId) {
                slots.delete(pluginId);
                continue;
            }
            if (slot?.current?.occurrenceId === occurrenceId) continue;
            const current = Object.freeze({
                occurrenceId,
                sourceCustody: registry.readPluginSourceCustody?.(pluginId) ?? null,
            });
            if (slot) slot.current = current;
            else slots.set(pluginId, { pluginId, current });
        }
    }

    function readServingSlotOccurrence(pluginId: string): PluginRuntimeSlotOccurrence | null {
        if (shutdownStarted) return null;
        return slots.get(pluginId)?.current ?? null;
    }

    function applyCurrentResourceSessionAccessWitness(
        registry: ResolvedExecutablePluginRuntimeRegistry,
    ): void {
        if (!currentResourceSessionAccessWitness) return;
        registry.applyResourceSessionAccessWitness?.(currentResourceSessionAccessWitness);
    }

    function notifyReloadListeners(result: PluginReloadResult): void {
        for (const listener of reloadListeners) {
            try {
                listener(result);
            } catch (error) {
                logger.debug('[PLUGIN RUNTIME] Plugin runtime registry listener threw', {
                    error: projectPluginFailureText(error),
                });
            }
        }
    }

    function notifyRunningSessionDispositionListeners(
        event: PluginRunningSessionDispositionEvent,
    ): void {
        for (const listener of runningSessionDispositionListeners) {
            try {
                listener(event);
            } catch (error) {
                logger.debug(
                    '[PLUGIN RUNTIME] Running Session disposition listener threw',
                    { error: projectPluginFailureText(error) },
                );
            }
        }
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
        const durableRevision = registry === activeRegistry
            ? (activeRegistryDurableRevision ?? registry.durableRevision ?? -1)
            : (registry.durableRevision ?? -1);
        let released = false;
        return {
            registry,
            source: 'active',
            durableRevision,
            resolveCurrentPluginMaterializationRef: (pluginId) => {
                if (shutdownStarted) return null;
                return activeRegistry?.resolveCurrentPluginMaterializationRef?.(pluginId) ?? null;
            },
            resolveCurrentMediatorContributionMaterializationRef: (mediator) => {
                if (shutdownStarted) return null;
                return activeRegistry?.resolveCurrentMediatorContributionMaterializationRef?.(mediator) ?? null;
            },
            release: async () => {
                if (released) return;
                released = true;
                await releaseRegistryLease(registry);
            },
        };
    }

    async function waitForRegistryLeasesToDrain(
        registries: ReadonlySet<ResolvedExecutablePluginRuntimeRegistry>,
        timeoutMs: number | null,
    ): Promise<void> {
        const drained = () => [...registries].every(
            (registry) => (outstandingLeaseCounts.get(registry) ?? 0) === 0,
        );
        if (drained()) return;
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        let listener: (() => void) | null = null;
        const drainPromise = new Promise<void>((resolve) => {
            listener = () => {
                if (drained()) resolve();
            };
            leaseDrainListeners.add(listener);
        });
        if (timeoutMs === null) {
            await drainPromise;
        } else {
            await Promise.race([drainPromise, new Promise<void>((resolve) => {
                timeoutHandle = setTimeout(resolve, timeoutMs);
                timeoutHandle.unref?.();
            })]);
        }
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
                error: projectPluginFailureText(error),
            });
        });
    }

    async function disposeRegistryForShutdown(
        registry: ResolvedExecutablePluginRuntimeRegistry,
        timeoutMs: number | null,
        projectRetirement?: Promise<void>,
    ): Promise<void> {
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        const disposePromise = Promise.all([registry.dispose({
            ...(timeoutMs === null ? {} : { timeoutMs }),
            onError: (event) => {
                logger.warn('[PLUGIN RUNTIME] Plugin cleanup failed during daemon shutdown', {
                    pluginId: event.pluginId,
                    phase: event.phase,
                    error: projectPluginFailureText(event.error),
                });
            },
        }), ...(projectRetirement ? [projectRetirement] : [])]).then(
            () => 'disposed' as const,
            (error: unknown) => {
                logger.warn('[PLUGIN RUNTIME] Plugin runtime registry disposal failed during daemon shutdown', {
                    error: projectPluginFailureText(error),
                });
                return 'failed' as const;
            },
        );
        if (timeoutMs === null) {
            await disposePromise;
            return;
        }
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
        _attemptedGeneration: number,
        resolveRuntimeRegistryOverride?: () => Promise<ResolvedExecutablePluginRuntimeRegistry>,
    ): Promise<ResolvedExecutablePluginRuntimeRegistry> {
        const resolver = resolveRuntimeRegistryOverride ?? params?.resolveRuntimeRegistry;
        if (!resolver) {
            throw new Error(
                'Plugin runtime registry is unavailable until the daemon lifecycle owner publishes it',
            );
        }
        return await resolver();
    }

    function getTargetedContributionsOwner(): StableTargetedContributionsOwner {
        if (!targetedContributionsOwner) {
            targetedContributionsOwner = createReloadControllerTargetedContributionsService({
                reloadController: controller,
            });
        }
        return targetedContributionsOwner;
    }

    function createActiveResult(
        registry: ResolvedExecutablePluginRuntimeRegistry,
        changedPluginIds: readonly string[],
        runningSessionDisposition: PluginRunningSessionDisposition | null = null,
    ): Extract<PluginReloadResult, { ok: true }> {
        return {
            ok: true,
            generation,
            attemptedGeneration: generation,
            requestedPluginIds: changedPluginIds,
            changedPluginIds,
            affectedPluginIds: changedPluginIds,
            runningSessionDisposition,
            activeGenerationId: resolveActiveGenerationId(generation),
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
                message: projectPluginFailureText(error),
            });
            lastResult = {
                ok: false,
                generation,
                attemptedGeneration,
                requestedPluginIds: Object.freeze([]),
                changedPluginIds: Object.freeze([]),
                affectedPluginIds: Object.freeze([]),
                runningSessionDisposition: null,
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
            hasBlockingPluginReloadDiagnostic(registry, [pluginId])
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
            retainProjectCustody(registry);
            published = true;
            generation = attemptedGeneration;
            applyCurrentResourceSessionAccessWitness(registry);
            registry.publishDeclaredEventSubscriptions?.();
            activeRegistryDurableRevision = registry.durableRevision ?? -1;
            activeRegistry = registry;
            publishSlots(registry);
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
                message: projectPluginFailureText(error),
            });
            lastResult = {
                ok: false,
                generation,
                attemptedGeneration,
                requestedPluginIds: Object.freeze([]),
                changedPluginIds: Object.freeze([]),
                affectedPluginIds: Object.freeze([]),
                runningSessionDisposition: null,
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
        if (shutdownStarted) throw createShutdownError();
        try {
            registry.startAdoptedBackgroundServices?.();
        } catch (error) {
            logger.warn('[PLUGIN RUNTIME] Adopted background-service start failed', {
                error: projectPluginFailureText(error),
            });
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

    controller = {
        async adoptPreparedRuntimeRegistry(adoption) {
            if (shutdownStarted) {
                await adoption.registry.dispose();
                throw createShutdownError();
            }

            const changedPluginIds = normalizePluginIds(adoption.changedPluginIds);
            if (
                adoption.durableRevision !== undefined
                && highestObservedDurableRevision !== null
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
            if (adoption.durableRevision !== undefined) {
                highestObservedDurableRevision = adoption.durableRevision;
            }

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
            const developmentBaseDurableRevision = highestObservedDurableRevision;
            let published = false;
            const publish = () => {
                if (published) {
                    throw new Error('Plugin runtime registry publication callback was invoked more than once');
                }
                if (shutdownStarted) throw createShutdownError();
                if (adoption.isDevelopmentCandidateCurrent && (
                    adoption.isDevelopmentCandidateCurrent() === false
                    || highestObservedDurableRevision !== developmentBaseDurableRevision
                )) {
                    throw new Error('Prepared plugin development candidate was superseded before publication');
                }
                if (
                    adoption.durableRevision !== undefined
                    && adoption.durableRevision !== highestObservedDurableRevision
                ) {
                    throw new Error(
                        `Prepared plugin runtime registry durable revision ${adoption.durableRevision} `
                        + `was superseded by newer durable revision ${highestObservedDurableRevision}`,
                    );
                }
                retainProjectCustody(adoption.registry);
                previousRegistry?.fencePluginConsumers?.(changedPluginIds);
                published = true;
                generation += 1;
                previousRegistry?.retireLiveSubscriptionConsumers?.(changedPluginIds);
                applyCurrentResourceSessionAccessWitness(adoption.registry);
                adoption.registry.publishDeclaredEventSubscriptions?.();
                if (adoption.durableRevision !== undefined) {
                    activeRegistryDurableRevision = adoption.durableRevision;
                }
                activeRegistry = adoption.registry;
                publishSlots(adoption.registry);
                if (previousRegistry && previousRegistry !== adoption.registry) {
                    // Shutdown custody, taken synchronously with the atomic
                    // publication swap: the predecessor is retired as of now,
                    // but its lease-safe retirement handoff has not run yet.
                    // Claiming it here keeps shutdown exact-once while the
                    // awaited adoption hook or post-publication failure paths
                    // have not settled. Ordinary lease releases must not
                    // dispose it from this state while the publication hook
                    // still owns adoption completion.
                    shutdownCustodyPredecessors.add(previousRegistry);
                }
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
                if (hasBlockingPluginReloadDiagnostic(adoption.registry, changedPluginIds)) {
                    throw new Error(
                        'Prepared plugin runtime registry contains a blocking activation diagnostic',
                    );
                }
                if (adoption.isDevelopmentCandidateCurrent?.() === false) {
                    throw new Error('Prepared plugin development candidate was superseded before adoption');
                }
                // A durable candidate reaches this controller only after its
                // committed authority can no longer roll back. Fence that
                // predecessor immediately while reconciliation settles. A
                // development candidate has no such committed authority and
                // must retain its incumbent until the synchronous publish
                // boundary below.
                if (adoption.durableRevision !== undefined) {
                    previousRegistry?.fencePluginConsumers?.(changedPluginIds);
                }
                if (adoption.beforePublish) {
                    await adoption.beforePublish(adoption.registry, publish);
                } else {
                    publish();
                }
            } catch (error) {
                if (!published) {
                    await adoption.registry.dispose();
                    throw error;
                }
                logger.warn('[PLUGIN RUNTIME] Plugin runtime post-publication reconciliation failed', {
                    error: projectPluginFailureText(error),
                });
            }
            if (!published) {
                await adoption.registry.dispose();
                throw new Error('Plugin runtime registry pre-publication owner returned without publishing');
            }
            // Publication is the synchronous ownership boundary. Only the
            // registry that actually became current may retire its predecessor;
            // a stale or otherwise rejected candidate therefore cannot disturb
            // the incumbent while awaiting pre-publication reconciliation.
            try {
                await previousRegistry?.retirePluginConsumers?.(changedPluginIds);
                await previousRegistry?.settleRetiredBackgroundServices?.(changedPluginIds);
            } catch (error) {
                logger.warn('[PLUGIN RUNTIME] Published plugin predecessor retirement failed', {
                    error: projectPluginFailureText(error),
                });
            }
            try {
                if (shutdownStarted) throw createShutdownError();
                try {
                    adoption.registry.startAdoptedBackgroundServices?.();
                } catch (error) {
                    logger.warn('[PLUGIN RUNTIME] Adopted background-service start failed', {
                        error: projectPluginFailureText(error),
                    });
                }
                params?.invalidateCaches?.(generation);
                lastResult = createActiveResult(
                    adoption.registry,
                    changedPluginIds,
                    adoption.runningSessionDisposition,
                );
                notifyReloadListeners(lastResult);
            } finally {
                if (previousRegistry && previousRegistry !== adoption.registry) {
                    // Once shutdown has not claimed the predecessor through its
                    // custody snapshot, any settled adoption (normal or failed
                    // housekeeping) transfers it into the existing lease-safe
                    // retirement path. Ownership stays with the one disposal
                    // coordinator; the custody entry only covers the gap.
                    const custodyHeld = shutdownCustodyPredecessors.delete(previousRegistry);
                    if (custodyHeld && !shutdownStarted) {
                        disposeRegistryWhenSafeInBackground(previousRegistry);
                    }
                }
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
        readPluginSlot(pluginId) {
            if (shutdownStarted) return null;
            return slots.get(pluginId) ?? null;
        },
        readCurrentPluginOccurrenceId(pluginId) {
            return readServingSlotOccurrence(pluginId)?.occurrenceId ?? null;
        },
        isPluginOccurrenceCurrent(pluginId, occurrenceId) {
            return readServingSlotOccurrence(pluginId)?.occurrenceId === occurrenceId;
        },
        readCurrentPluginSourceCustody(pluginId) {
            return readServingSlotOccurrence(pluginId)?.sourceCustody ?? null;
        },
        retainServingSlots(excludedPluginIds) {
            const occurrencesByPluginId = new Map<string, PluginRuntimeSlotOccurrence>();
            const leases: PluginRuntimeActivationRegistryLease[] = [];
            const unretainedActivePluginIds: string[] = [];
            if (!shutdownStarted && activeRegistry) {
                const activatedPluginIds = activeRegistry.activatedPluginIds;
                for (const slot of slots.values()) {
                    if (excludedPluginIds.has(slot.pluginId)) continue;
                    if (slot.current) occurrencesByPluginId.set(slot.pluginId, slot.current);
                    const lease = slot.current
                        ? activeRegistry.retainPluginActivationComponent?.(slot.pluginId) ?? null
                        : null;
                    if (lease) leases.push(lease);
                    else if (activatedPluginIds.has(slot.pluginId)) unretainedActivePluginIds.push(slot.pluginId);
                }
            }
            return Object.freeze({
                occurrencesByPluginId,
                leases: Object.freeze(leases),
                unretainedActivePluginIds: Object.freeze(unretainedActivePluginIds),
            });
        },
        invalidateRuntimeProjection() {
            if (!shutdownStarted && activeRegistry) {
                params?.invalidateCaches?.(generation);
            }
        },
        applyResourceSessionAccessWitness(input) {
            const nextWitness: ResourceSessionAccessWitness = input.witness === undefined
                ? Object.freeze({ accountId: input.accountId })
                : Object.freeze({ accountId: input.accountId, witness: input.witness });
            const currentWitness = currentResourceSessionAccessWitness;
            if (
                currentWitness
                && currentWitness.accountId === nextWitness.accountId
                && currentWitness.witness !== undefined
                && nextWitness.witness !== undefined
                && nextWitness.witness.throughCursor
                    < currentWitness.witness.throughCursor
            ) {
                // A live Resource owner already rejects stale pages. Preserve
                // that same current carrier for a replacement, which begins
                // with no prior page state to compare itself.
                return;
            }
            currentResourceSessionAccessWitness = nextWitness;
            for (const registry of resourceSessionRegistries()) {
                registry.applyResourceSessionAccessWitness?.(currentResourceSessionAccessWitness);
            }
        },
        async shutdown(shutdownParams) {
            if (shutdownPromise) return await shutdownPromise;
            shutdownPromise = (async () => {
                shutdownStarted = true;
                shutdownTimeoutMs = normalizeShutdownTimeoutMs(shutdownParams?.timeoutMs);
                const projectRetirement = projectManagedServicesOwner
                    ? Promise.all([projectManagedServicesOwner.retireProjectServices(), projectManagedServicesOwner.retireSharedProviderServices()]).then(() => undefined)
                    : undefined;
                // The same shutdown join below reports failures. Attach its
                // handler now while admitted registry leases are draining.
                void projectRetirement?.catch(() => undefined);
                activeRegistry?.retireLiveSubscriptionConsumers?.();
                const registriesToDispose = new Set<ResolvedExecutablePluginRuntimeRegistry>();
                if (activeRegistry) registriesToDispose.add(activeRegistry);
                for (const registry of pendingDisposal) registriesToDispose.add(registry);
                for (const registry of shutdownCustodyPredecessors) registriesToDispose.add(registry);
                activeRegistry = null;
                activeRegistryDurableRevision = null;
                unsubscribeServingRegistryFences?.();
                unsubscribeServingRegistryFences = null;
                slots.clear();
                pendingDisposal.clear();
                shutdownCustodyPredecessors.clear();
                await waitForRegistryLeasesToDrain(registriesToDispose, shutdownTimeoutMs);
                outstandingLeaseCounts.clear();
                for (const registry of registriesToDispose) {
                    // eslint-disable-next-line no-await-in-loop
                    await disposeRegistryForShutdown(registry, shutdownTimeoutMs, projectRetirement);
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
        getTargetedContributionsOwner,
        currentGlobalExternalSessions,
        publishDurableRunningSessionDisposition(event) {
            notifyRunningSessionDispositionListeners(Object.freeze({
                durableRevision: event.durableRevision,
                changedPluginIds: normalizePluginIds(
                    event.changedPluginIds,
                ),
                runningSessionDisposition:
                    event.runningSessionDisposition,
                ...(event.runningSessionRevocationScope
                    ? {
                        runningSessionRevocationScope: Object.freeze({
                            ...event.runningSessionRevocationScope,
                        }),
                    }
                    : {}),
            }));
        },
        subscribeRunningSessionDisposition(listener) {
            runningSessionDispositionListeners.add(listener);
            return () => {
                runningSessionDispositionListeners.delete(listener);
            };
        },
    };
    return controller;
}
