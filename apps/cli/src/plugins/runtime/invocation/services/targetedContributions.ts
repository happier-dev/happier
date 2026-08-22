import { PluginError } from '@happier-dev/plugin-sdk';
import type {
    TargetedContributionPointRef,
    TargetedContributionObservation,
    TargetedContributionSnapshot,
    TargetedContributionsService,
} from '@happier-dev/plugin-sdk';
import type { PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import type { AdmittedTargetedContributionSnapshot } from '@/plugins/projection/registry/types';
import { createAdmittedTargetedOperationExecutionHandle } from './actions';

/**
 * The narrow, daemon-lifetime source for one target's admitted contribution
 * view.  It deliberately offers a complete snapshot and a level trigger only:
 * the runtime registry remains the sole admission and normalization owner.
 */
export type TargetedContributionsAdmissionSource<TContribution = unknown> = Readonly<{
    subscribeToCatalogChanges(listener: () => void): () => void;
    readAdmittedSnapshot(params: Readonly<{
        pluginId: string;
        point: TargetedContributionPointRef<unknown>;
        signal?: AbortSignal;
    }>): Promise<TargetedContributionSnapshot<TContribution>>;
}>;

export type StableTargetedContributionsOwner<TContribution = unknown> = Readonly<{
    bind(params: Readonly<{
        pluginId: string;
        signal: AbortSignal;
        isCurrent(): boolean;
    }>): TargetedContributionsService;
}>;

/**
 * One daemon-lifetime bridge from the incumbent reload controller to the
 * registry's already-admitted snapshot. The canonical registry reader remains
 * the only admission and normalization owner.
 */
export type ReloadControllerTargetedContributionsHost = Readonly<{
    reloadController: PluginReloadController;
}>;

function staleGeneration(): PluginError {
    return new PluginError({
        code: 'plugin_generation_stale',
        message: 'Plugin generation is stale',
    });
}

function operationAborted(): PluginError {
    return new PluginError({
        code: 'plugin_targeted_contributions_aborted',
        message: 'Targeted contribution observation was aborted',
    });
}

function targetPointMismatch(): PluginError {
    return new PluginError({
        code: 'plugin_targeted_contributions_target_mismatch',
        message: 'Targeted contribution point does not belong to this plugin',
    });
}

function targetedContributionsUnavailable(): PluginError {
    return new PluginError({
        code: 'plugin_targeted_contributions_unavailable',
        message: 'Targeted contribution snapshot is unavailable',
    });
}

/**
 * Projects the registry's already-semantic snapshot into public operation
 * handles. The cold registry owns parser selection; this bridge carries the
 * exact parser pair only into the opaque Action-handle binding.
 */
function projectAdmittedSnapshot(
    point: TargetedContributionPointRef<unknown>,
    snapshot: AdmittedTargetedContributionSnapshot,
): TargetedContributionSnapshot<unknown> {
    const contributions = snapshot.contributions.map((contribution) => {
        const contributor = Object.freeze({
            pluginId: contribution.contributor.pluginId,
            contributionId: contribution.contributor.contributionId,
            immutableGenerationId:
                contribution.contributor.immutableGenerationId,
        });
        const protocol = Object.freeze({
            id: contribution.protocol.id,
            version: contribution.protocol.version,
        });
        return Object.freeze({
            contributor,
            protocol,
            ...(contribution.descriptor === undefined ? {} : { descriptor: contribution.descriptor }),
            operations: Object.freeze(Object.fromEntries(
                contribution.operations.map((operation) => [
                    operation.role,
                    createAdmittedTargetedOperationExecutionHandle({
                        action: operation.action,
                        targetImmutableGenerationId: snapshot.target.immutableGenerationId,
                        identity: {
                            target: { pluginId: point.targetPluginId },
                            point: {
                                pointId: point.id,
                                protocol,
                            },
                            contributor,
                            role: operation.role,
                        },
                        selectedActionInput: operation.selectedActionInput,
                        targetProtocol: operation.targetProtocol,
                    }),
                ]),
            )),
            surfaces: Object.freeze(Object.fromEntries(contribution.surfaces.map((surface) => [
                surface.role,
                Object.freeze({
                    point: Object.freeze({
                        pointId: point.id,
                        protocol: Object.freeze({
                            id: point.protocol.id,
                            version: point.protocol.version,
                        }),
                    }),
                    contributor,
                    role: surface.role,
                    presentation: surface.presentation,
                }),
            ]))),
        });
    });
    return Object.freeze({
        generation: snapshot.target.immutableGenerationId,
        contributions: Object.freeze(contributions),
    });
}

function assertSelfTarget(
    point: TargetedContributionPointRef<unknown>,
    pluginId: string,
): void {
    if (point.targetPluginId !== pluginId) throw targetPointMismatch();
}

function assertTargetCurrent(
    binding: Readonly<{ signal: AbortSignal; isCurrent(): boolean }>,
): void {
    if (binding.signal.aborted || !binding.isCurrent()) throw staleGeneration();
}

function composeSignals(
    targetSignal: AbortSignal,
    operationSignal: AbortSignal | undefined,
): AbortSignal {
    if (!operationSignal || operationSignal === targetSignal) return targetSignal;
    return AbortSignal.any([targetSignal, operationSignal]);
}

async function withCancellation<T>(
    operation: Promise<T>,
    signal: AbortSignal | undefined,
): Promise<T> {
    if (!signal) return await operation;
    if (signal.aborted) throw operationAborted();
    let rejectAbort!: (error: PluginError) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = reject;
    });
    const onAbort = () => rejectAbort(operationAborted());
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    try {
        return await Promise.race([operation, aborted]);
    } finally {
        signal.removeEventListener('abort', onAbort);
        // The source may still be settling after a caller cancellation.  Its
        // result is intentionally ignored, but its rejection remains handled.
        void operation.catch(() => {});
    }
}

/**
 * Binds the public target-local observation service to the canonical admitted
 * snapshot source.  Subscription is reserved synchronously before callers can
 * issue their first read, eliminating the read-to-observe gap without making a
 * registry watch or delta protocol public.
 */
export function createTargetedContributionsService<TContribution = unknown>(
    source: TargetedContributionsAdmissionSource<TContribution>,
): StableTargetedContributionsOwner<TContribution> {
    return Object.freeze({
        bind(
            binding: Parameters<
                StableTargetedContributionsOwner<TContribution>['bind']
            >[0],
        ): TargetedContributionsService {
            return Object.freeze({
                observeForSelf<TObservedContribution>(
                    point: TargetedContributionPointRef<TObservedContribution>,
                    options: Readonly<{ onInvalidated: () => void }>,
                ): TargetedContributionObservation<TObservedContribution> {
                    assertTargetCurrent(binding);
                    assertSelfTarget(
                        point as TargetedContributionPointRef<unknown>,
                        binding.pluginId,
                    );
                    let disposed = false;
                    let readCount = 0;
                    let invalidationPending = false;
                    let invalidationScheduled = false;
                    let unsubscribe: (() => void) | null = null;

                    const dispose = () => {
                        if (disposed) return;
                        disposed = true;
                        binding.signal.removeEventListener('abort', dispose);
                        unsubscribe?.();
                        unsubscribe = null;
                    };

                    const scheduleInvalidation = () => {
                        if (disposed || invalidationScheduled || readCount > 0 || !invalidationPending) return;
                        invalidationScheduled = true;
                        queueMicrotask(() => {
                            invalidationScheduled = false;
                            if (disposed || readCount > 0 || !invalidationPending) return;
                            invalidationPending = false;
                            if (binding.signal.aborted || !binding.isCurrent()) {
                                dispose();
                                return;
                            }
                            try {
                                options.onInvalidated();
                            } catch {
                                // A target callback cannot break the daemon's reload publication.
                            }
                            scheduleInvalidation();
                        });
                    };

                    const invalidate = () => {
                        if (disposed || binding.signal.aborted || !binding.isCurrent()) {
                            dispose();
                            return;
                        }
                        invalidationPending = true;
                        scheduleInvalidation();
                    };

                    // Registration is intentionally first and synchronous.
                    const registration = source.subscribeToCatalogChanges(invalidate);
                    if (disposed) registration();
                    else unsubscribe = registration;
                    binding.signal.addEventListener('abort', dispose, { once: true });
                    if (binding.signal.aborted || !binding.isCurrent()) dispose();

                    return Object.freeze({
                        dispose,
                        async readCurrent(
                            options?: PluginCancellationOptions,
                        ): Promise<TargetedContributionSnapshot<TObservedContribution>> {
                            assertTargetCurrent(binding);
                            if (options?.signal?.aborted) throw operationAborted();
                            readCount += 1;
                            const signal = composeSignals(binding.signal, options?.signal);
                            try {
                                let snapshot: TargetedContributionSnapshot<TContribution>;
                                try {
                                    snapshot = await withCancellation(
                                        source.readAdmittedSnapshot({
                                            pluginId: binding.pluginId,
                                            point: point as TargetedContributionPointRef<unknown>,
                                            signal,
                                        }),
                                        signal,
                                    );
                                } catch (error) {
                                    // A target retirement is a stale-handle
                                    // result, even if it reached the source as
                                    // an AbortSignal first. Caller cancellation
                                    // remains distinct.
                                    assertTargetCurrent(binding);
                                    if (options?.signal?.aborted) throw operationAborted();
                                    throw error;
                                }
                                assertTargetCurrent(binding);
                                if (options?.signal?.aborted) throw operationAborted();
                                return snapshot as unknown as TargetedContributionSnapshot<TObservedContribution>;
                            } finally {
                                readCount -= 1;
                                scheduleInvalidation();
                            }
                        },
                    });
                },
            });
        },
    });
}

/**
 * Adapts the stable daemon reload snapshot to target-local observations.  A
 * contributor replacement invalidates the target's view; only replacement of
 * the target itself retires its observation.  In particular, this never binds
 * to generation-local `retireLiveSubscriptionConsumers`.
 */
export function createReloadControllerTargetedContributionsService(
    host: ReloadControllerTargetedContributionsHost,
): StableTargetedContributionsOwner {
    return Object.freeze({
        bind(
            binding: Parameters<StableTargetedContributionsOwner['bind']>[0],
        ): TargetedContributionsService {
            return createTargetedContributionsService({
                subscribeToCatalogChanges(listener: () => void): () => void {
                    return host.reloadController.subscribe((result) => {
                        if (!result.ok || result.changedPluginIds.length === 0) return;
                        // `retirePluginConsumers` synchronously retires the
                        // target generation before the controller publishes
                        // this result. The common invalidation path observes
                        // that canonical signal/currentness and disposes.
                        listener();
                    });
                },
                async readAdmittedSnapshot(
                    params: Parameters<
                        TargetedContributionsAdmissionSource['readAdmittedSnapshot']
                    >[0],
                ): Promise<TargetedContributionSnapshot<unknown>> {
                    const lease = await host.reloadController.acquireRuntimeRegistry();
                    try {
                        if (params.signal?.aborted) throw operationAborted();
                        const snapshot = lease.registry.readAdmittedTargetedContributions?.({
                            targetPluginId: params.pluginId,
                            pointId: params.point.id,
                            protocol: params.point.protocol,
                        });
                        if (!snapshot) throw targetedContributionsUnavailable();
                        return projectAdmittedSnapshot(params.point, snapshot);
                    } finally {
                        await lease.release();
                    }
                },
            }).bind(binding);
        },
    });
}
