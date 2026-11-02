/** @moduleRealm any */
import { PluginError } from '../errors.js';
import type { TargetedContributionPointRef, TargetedContributionObservation, TargetedContributionSnapshot, TargetedContributionsService } from './contracts.js';
import type { PluginCancellationOptions } from './contracts.js';
import type { AdmittedTargetedContributionSnapshot } from './targetedContributionTypes.js';
import { createAdmittedTargetedOperationExecutionHandle } from './admittedTargetedOperation.js';
import { resolveManifestTargetedContributions, type TargetedContributionManifestDeclaration } from './targetedContributionAdmission.js';
import { normalizePluginSourceCustodyV1 } from '@happier-dev/protocol/plugins/runtime/sourceCustody';

/** Binds current host-owned manifest custody to the existing target-local admission and observation owners. */
export function createManifestTargetedContributionsService(host: Readonly<{
    readCurrentDeclarations(signal?: AbortSignal): readonly TargetedContributionManifestDeclaration[] | Promise<readonly TargetedContributionManifestDeclaration[]>;
    subscribeToCatalogChanges(listener: () => void): () => void;
}>): StableTargetedContributionsOwner {
    return createTargetedContributionsService({
        subscribeToCatalogChanges(listener) {
            return host.subscribeToCatalogChanges(listener);
        },
        async readAdmittedSnapshot({ pluginId, point, signal }) {
            const declarations = await host.readCurrentDeclarations(signal);
            const admitted = resolveManifestTargetedContributions(declarations).read({
                targetPluginId: pluginId,
                pointId: point.id,
                protocol: point.protocol,
            });
            if (!admitted) throw targetedContributionsUnavailable();
            return projectAdmittedTargetedContributionSnapshot(point, admitted, (id, occurrenceId) => (
                declarations.find((row) => row.manifest.id === id && row.occurrenceId === occurrenceId)?.sourceCustody ?? null
            ), declarations.find((row) => row.manifest.id === admitted.target.pluginId
                && row.occurrenceId === admitted.target.occurrenceId)?.targetSourceCustody);
        },
    });
}

/**
 * The narrow, host-lifetime source for one target's admitted contribution
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

function staleGeneration(): PluginError {
    return new PluginError({
        code: 'plugin_generation_stale',
        message: 'Plugin occurrenceId is stale',
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
export function projectAdmittedTargetedContributionSnapshot(
    point: TargetedContributionPointRef<unknown>,
    snapshot: AdmittedTargetedContributionSnapshot,
    readPluginSourceCustody: (pluginId: string, occurrenceId: string) => import('@happier-dev/protocol').PluginSourceCustodyV1 | null,
    selectedTargetSourceCustody?: import('@happier-dev/protocol').PluginSourceCustodyV1,
): TargetedContributionSnapshot<unknown> {
    const rawTargetSourceCustody = selectedTargetSourceCustody ?? readPluginSourceCustody(snapshot.target.pluginId, snapshot.target.occurrenceId);
    if (!rawTargetSourceCustody) throw targetedContributionsUnavailable();
    const targetSourceCustody = normalizePluginSourceCustodyV1(rawTargetSourceCustody);
    const contributions = snapshot.contributions.map((contribution) => {
        const rawSourceCustody = readPluginSourceCustody(contribution.contributor.pluginId, contribution.contributor.occurrenceId);
        if (!rawSourceCustody) throw targetedContributionsUnavailable();
        const sourceCustody = normalizePluginSourceCustodyV1(rawSourceCustody);
        const contributor = Object.freeze({
            pluginId: contribution.contributor.pluginId,
            contributionId: contribution.contributor.contributionId,
            occurrenceId: contribution.contributor.occurrenceId,
            sourceCustody,
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
                contribution.operations.map((operation) => {
                    const operationSourceCustody = readPluginSourceCustody(operation.contributor.pluginId, operation.contributor.occurrenceId);
                    if (!operationSourceCustody) throw targetedContributionsUnavailable();
                    return [
                        operation.role,
                        createAdmittedTargetedOperationExecutionHandle({
                            action: operation.action,
                            targetOccurrenceId: snapshot.target.occurrenceId,
                            targetSourceCustody,
                            ...(operation.unavailable ? { unavailable: true } : {}),
                            identity: {
                                target: { pluginId: point.targetPluginId },
                                point: {
                                    pointId: point.id,
                                    protocol,
                                },
                                contributor: Object.freeze({ ...operation.contributor, sourceCustody: operationSourceCustody }),
                                role: operation.role,
                            },
                            selectedActionInput: operation.selectedActionInput,
                            targetProtocol: operation.targetProtocol,
                        }),
                    ];
                }),
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
        occurrenceId: snapshot.target.occurrenceId,
        sourceCustody: targetSourceCustody,
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
                                // A target callback cannot break host catalog publication.
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
