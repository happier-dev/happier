import { applyObservedProgressToExternalSessionAttentionV1 } from '@happier-dev/protocol/sessions/external/linked-metadata';
import type { ExternalSessionObservedProgress } from '@happier-dev/protocol';

import type {
    ExternalSessionFollowLease,
    ExternalSessionFollowRefreshResult,
    ExternalSessionFollowResource,
} from '@/api/session/external/leases/createExternalSessionFollowLeaseManager';
import type {
    ExternalSessionObservationLinkInput,
} from '@/api/session/external/leases/resolveExternalSessionObservationLinkInput';
import {
    deriveExternalSessionObservedProgress,
    updateSessionMetadataWithObservedExternalSessionProgress,
} from '@/api/session/external/backgroundFollow/externalSessionBackgroundFollowMetadata';
import {
    loadLinkedExternalSession,
} from '@/api/session/external/takeover/loadLinkedExternalSession';
import type { ExternalSessionFollowSource } from '@/session/external/admitProviderSessionFollowSource';
import type { StoredCredentials } from '@/persistence';
import {
    ExternalSessionFollowFailureError,
} from '@/session/external/externalSessionFollowFailure';
import type { ExternalSessionExecutionSurface, ExternalSessionTranscriptReadAfter } from '@/session/external/providerOps';

function accumulateObservedProgress(
    previous: ExternalSessionObservedProgress | null,
    items: Parameters<typeof deriveExternalSessionObservedProgress>[0],
): ExternalSessionObservedProgress | null {
    const attention = applyObservedProgressToExternalSessionAttentionV1(
        previous ? { observedProgressToken: previous.token, observedAtMs: previous.atMs } : null,
        deriveExternalSessionObservedProgress(items),
    );
    return attention?.observedProgressToken !== undefined && attention.observedAtMs !== undefined
        ? { token: attention.observedProgressToken, atMs: attention.observedAtMs }
        : null;
}

/** Consumer application settles before the same source's next page is read. */
export async function drainCanonicalExternalSessionTranscriptReadAfter(params: Readonly<{
    cursor: string;
    isCurrent: () => boolean;
    read: (cursor: string) => Promise<ExternalSessionTranscriptReadAfter>;
    apply: (
        page: Extract<ExternalSessionTranscriptReadAfter, { outcome: 'advanced' }>,
        fromCursor: string,
    ) => void | Promise<void>;
}>): Promise<Pick<ExternalSessionTranscriptReadAfter, 'outcome'> | undefined> {
    let cursor = params.cursor;
    const seenCursors = new Set([cursor]);
    while (params.isCurrent()) {
        const result = await params.read(cursor);
        if (!params.isCurrent()) return;
        if (result.outcome !== 'advanced') {
            return result.outcome === 'already_current' && cursor !== params.cursor
                ? { outcome: 'advanced' }
                : result;
        }
        if (seenCursors.has(result.nextCursor)
            || result.diagnostics?.some(diagnostic => diagnostic.severity === 'required')) {
            return { outcome: 'gap_or_cursor_expired' };
        }
        await params.apply(result, cursor);
        if (!params.isCurrent()) return;
        cursor = result.nextCursor;
        seenCursors.add(cursor);
        if (!result.hasMore) return { outcome: 'advanced' };
    }
    return;
}

export function canAttemptCanonicalExternalSessionLiveFollow(params: Readonly<{
    observation: ExternalSessionObservationLinkInput | null;
    resource: ExternalSessionFollowResource;
    providerOps: Pick<
        ExternalSessionExecutionSurface,
        'pageTranscript' | 'readAfterTranscript'
    >;
}>): boolean {
    return params.observation !== null
        && params.observation.link.changeObservation !== 'reconcile_only'
        && params.observation.resource.occurrenceId
            === params.resource.occurrenceId
        && params.observation.link.linkGeneration
            === params.resource.linkGeneration
        && typeof params.providerOps.pageTranscript === 'function'
        && typeof params.providerOps.readAfterTranscript === 'function';
}

export async function acquireCanonicalExternalSessionFollowLease(params: Readonly<{
    sessionId: string;
    machineId: string;
    linked: ExternalSessionFollowSource;
    providerSessionTarget?: true;
    resource: ExternalSessionFollowResource;
    observation: ExternalSessionObservationLinkInput;
    providerOps: Pick<
        ExternalSessionExecutionSurface,
        'pageTranscript' | 'readAfterTranscript'
    >;
    initialCursor?: string | null;
    maxBytes: number;
    maxItems: number;
    deadlineAtMs?: number;
    signal?: AbortSignal;
    observationProjection: Readonly<{
        reconcileTranscriptDemand(input: Readonly<{
            resolved: ExternalSessionObservationLinkInput;
            demanded: boolean;
        }>): Promise<Readonly<{ state: string }>>;
    }>;
    credentials: StoredCredentials;
}>): Promise<ExternalSessionFollowLease> {
    const isGenerationRetired = (): boolean =>
        params.resource.retirementSignal?.aborted === true;
    if (!params.providerOps.pageTranscript || !params.providerOps.readAfterTranscript) {
        throw new ExternalSessionFollowFailureError(
            'follow_unavailable',
            'Canonical External Session transcript reads are unavailable',
            'follow_transcript_reads_unavailable',
        );
    }
    if (
        params.observation.resource.occurrenceId !== params.resource.occurrenceId
        || params.observation.link.linkGeneration !== params.resource.linkGeneration
        || isGenerationRetired()
    ) {
        throw new ExternalSessionFollowFailureError(
            'source_changed',
            'External Session follow generation changed before acquisition',
        );
    }
    if (!canAttemptCanonicalExternalSessionLiveFollow(params)) {
        throw new ExternalSessionFollowFailureError(
            'follow_unavailable',
            'Canonical External Session live observation is unavailable',
            'follow_live_observation_unavailable',
        );
    }

    const streamCancellation = new AbortController();
    const streamSignal = AbortSignal.any([
        streamCancellation.signal,
        ...(params.signal ? [params.signal] : []),
        ...(params.resource.retirementSignal ? [params.resource.retirementSignal] : []),
    ]);
    let cursor = params.initialCursor?.trim() || null;
    let released = false;
    let releasePromise: Promise<void> | null = null;
    const inFlightRefreshWork = new Set<Promise<unknown>>();
    const isActive = (): boolean => !streamSignal.aborted;
    const loadCurrentLink = async (): Promise<ExternalSessionFollowSource | null> => {
        if (!isActive()) return null;
        // The native target was resolved and admitted by this bound Run. Its
        // lifetime follows the local cancel/retirement signal, not parent metadata.
        if (params.providerSessionTarget) return params.linked;
        const loaded = await loadLinkedExternalSession({
            credentials: params.credentials,
            sessionId: params.sessionId,
            machineId: params.machineId,
            expectedIdentity: {
                agentId: params.linked.agentId,
                machineId: params.linked.machineId,
                remoteSessionId: params.linked.remoteSessionId,
                source: params.linked.source,
            },
        }).catch(() => null);
        if (
            !isActive()
            || !loaded?.ok
            || loaded.session.linkGeneration !== params.resource.linkGeneration
        ) {
            return null;
        }
        return loaded.session;
    };
    const trackRefreshWork = <T>(operation: () => Promise<T>): Promise<T> => {
        let tracked!: Promise<T>;
        tracked = operation().finally(() => {
            inFlightRefreshWork.delete(tracked);
        });
        inFlightRefreshWork.add(tracked);
        return tracked;
    };
    const release = (): Promise<void> => {
        if (released) return Promise.resolve();
        if (releasePromise) return releasePromise;
        streamCancellation.abort();
        const attempt = (async () => {
            await params.observationProjection.reconcileTranscriptDemand({
                resolved: params.observation,
                demanded: false,
            });
            while (inFlightRefreshWork.size > 0) {
                await Promise.allSettled([...inFlightRefreshWork]);
            }
            released = true;
        })();
        releasePromise = attempt;
        void attempt.catch(() => {
            if (releasePromise === attempt) {
                releasePromise = null;
            }
        });
        return attempt;
    };
    const currentBeforeAdmission = await loadCurrentLink();
    if (!currentBeforeAdmission) {
        throw new ExternalSessionFollowFailureError(
            'source_changed',
            'External Session link changed before follow acquisition',
        );
    }
    let admitted: Readonly<{ state: string }>;
    try {
        admitted = await params.observationProjection.reconcileTranscriptDemand({
            resolved: params.observation,
            demanded: true,
        });
        if (admitted.state !== 'observing') {
            throw new ExternalSessionFollowFailureError(
                'follow_unavailable',
                `External Session live follow is unavailable: ${admitted.state}`,
                'follow_observer_not_observing',
            );
        }
    } catch (error) {
        await release();
        throw error;
    }
    const currentAfterAdmission = await loadCurrentLink();
    if (!currentAfterAdmission) {
        await release();
        throw new ExternalSessionFollowFailureError(
            'source_changed',
            isGenerationRetired()
                ? 'External Session follow generation retired during acquisition'
                : 'External Session link changed during follow acquisition',
        );
    }
    if (!cursor) {
        try {
            const baseline = await params.providerOps.pageTranscript({
                source: currentAfterAdmission.source,
                remoteSessionId: currentAfterAdmission.remoteSessionId,
                direction: 'older',
                maxBytes: params.maxBytes,
                maxItems: params.maxItems,
                ...(params.deadlineAtMs === undefined
                    ? {}
                    : { deadlineAtMs: params.deadlineAtMs }),
                signal: streamSignal,
            });
            cursor = baseline.tailCursor;
        } catch (error) {
            await release();
            throw error;
        }
        if (!await loadCurrentLink()) {
            await release();
            throw new ExternalSessionFollowFailureError(
                'source_changed',
                isGenerationRetired()
                    ? 'External Session follow generation retired during acquisition'
                    : 'External Session link changed during follow acquisition',
            );
        }
    }

    const establishCurrentTail = async (): Promise<void> => {
        const current = await loadCurrentLink();
        if (!current) return;
        const page = await params.providerOps.pageTranscript!({
            source: current.source,
            remoteSessionId: current.remoteSessionId,
            direction: 'older',
            maxBytes: params.maxBytes,
            maxItems: params.maxItems,
            signal: streamSignal,
        });
        if (isActive()) {
            cursor = page.tailCursor;
        }
    };

    const commitProgress = async (
        current: ExternalSessionFollowSource,
        observedProgress: ExternalSessionObservedProgress | null,
        nextCursor: string,
    ): Promise<boolean> => {
        if (!isActive()) return false;
        if (observedProgress && current.rawSession) {
            // The tuple writer owns relink conflicts; this refresh keeps its
            // captured credentials and source generation through the ACK.
            await updateSessionMetadataWithObservedExternalSessionProgress({
                token: params.credentials.token,
                credentials: params.credentials,
                sessionId: params.sessionId,
                rawSession: current.rawSession,
                observedProgress,
                lastKnownActivityAtMs: observedProgress.atMs,
                expectedLinkGeneration: current.linkGeneration,
            });
        }
        if (!isActive()) return false;
        cursor = nextCursor;
        return true;
    };

    const createGapRecovery = (): ExternalSessionFollowRefreshResult => {
        let recovery: Promise<Readonly<{ outcome: 'resync_required' }> | void> | null = null;
        return {
            outcome: 'gap_or_cursor_expired',
            recover: async () => {
                if (!isActive()) return;
                recovery ??= trackRefreshWork(async () => {
                    const current = await loadCurrentLink();
                    if (!current) {
                        throw new ExternalSessionFollowFailureError(
                            'source_changed',
                            'External Session source changed before bounded follow resync',
                        );
                    }
                    let pageCursor: string | undefined;
                    let capturedTail: string | null = null;
                    let observedProgress: ExternalSessionObservedProgress | null = null;
                    const seenCursors = new Set<string>();
                    while (isActive()) {
                        const page = await params.providerOps.pageTranscript!({
                            source: current.source,
                            remoteSessionId: current.remoteSessionId,
                            direction: 'older',
                            ...(pageCursor === undefined ? {} : { cursor: pageCursor }),
                            maxBytes: params.maxBytes,
                            maxItems: params.maxItems,
                            signal: streamSignal,
                        });
                        if (!isActive()) return;
                        capturedTail ??= page.tailCursor;
                        if (!capturedTail || page.truncated
                            || page.diagnostics?.some(diagnostic => diagnostic.severity === 'required')) {
                            return { outcome: 'resync_required' } as const;
                        }
                        observedProgress = accumulateObservedProgress(observedProgress, page.items);
                        if (!page.hasMore && !page.nextCursor) break;
                        if (!page.hasMore || !page.nextCursor || seenCursors.has(page.nextCursor)) {
                            return { outcome: 'resync_required' } as const;
                        }
                        seenCursors.add(page.nextCursor);
                        pageCursor = page.nextCursor;
                    }
                    if (capturedTail) await commitProgress(current, observedProgress, capturedTail);
                    return undefined;
                });
                return await recovery;
            },
        };
    };

    return {
        release,
        readAcceptedCursor: () => cursor,
        requestTranscriptRefresh: () => trackRefreshWork(async () => {
            if (!isActive()) return;
            if (!cursor) {
                await establishCurrentTail();
                return;
            }
            const current = await loadCurrentLink();
            if (!current) return;
            let nextCursor = cursor;
            let observedProgress: ExternalSessionObservedProgress | null = null;
            const result = await drainCanonicalExternalSessionTranscriptReadAfter({
                cursor,
                isCurrent: isActive,
                read: async (requestedCursor) => await params.providerOps.readAfterTranscript!({
                    source: current.source,
                    remoteSessionId: current.remoteSessionId,
                    cursor: requestedCursor,
                    maxBytes: params.maxBytes,
                    maxItems: params.maxItems,
                    signal: streamSignal,
                }),
                apply: (page) => {
                    observedProgress = accumulateObservedProgress(observedProgress, page.items);
                    nextCursor = page.nextCursor;
                },
            });
            if (!result) return;
            if (result.outcome === 'gap_or_cursor_expired') return createGapRecovery();
            if (result.outcome === 'already_current') return { outcome: 'already_current' };
            if (result.outcome !== 'advanced') return { outcome: result.outcome };
            if (await commitProgress(current, observedProgress, nextCursor)) return { outcome: 'advanced' };
            return undefined;
        }),
    };
}
