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
    type LoadedLinkedExternalSession,
} from '@/api/session/external/takeover/loadLinkedExternalSession';
import type { StoredCredentials } from '@/persistence';
import {
    ExternalSessionFollowFailureError,
} from '@/session/external/externalSessionFollowFailure';
import type { ExternalSessionExecutionSurface } from '@/session/external/providerOps';

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
        && params.observation.resource.pluginGeneration
            === params.resource.pluginGeneration
        && params.observation.link.linkGeneration
            === params.resource.linkGeneration
        && typeof params.providerOps.pageTranscript === 'function'
        && typeof params.providerOps.readAfterTranscript === 'function';
}

export async function acquireCanonicalExternalSessionFollowLease(params: Readonly<{
    sessionId: string;
    machineId: string;
    linked: LoadedLinkedExternalSession;
    resource: ExternalSessionFollowResource;
    observation: ExternalSessionObservationLinkInput;
    providerOps: Pick<
        ExternalSessionExecutionSurface,
        'pageTranscript' | 'readAfterTranscript'
    >;
    initialCursor?: string | null;
    maxBytes: number;
    maxItems: number;
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
        );
    }
    if (
        params.observation.resource.pluginGeneration !== params.resource.pluginGeneration
        || params.observation.link.linkGeneration !== params.resource.linkGeneration
        || isGenerationRetired()
    ) {
        throw new ExternalSessionFollowFailureError(
            'source_changed',
            'External Session follow generation changed before acquisition',
        );
    }

    let cursor = params.initialCursor?.trim() || null;
    let released = false;
    let releaseRequested = false;
    let releasePromise: Promise<void> | null = null;
    const inFlightRefreshWork = new Set<Promise<unknown>>();
    const loadCurrentLink = async (): Promise<LoadedLinkedExternalSession | null> => {
        if (released || releaseRequested || isGenerationRetired()) return null;
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
            released
            || releaseRequested
            || isGenerationRetired()
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
        releaseRequested = true;
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
                maxItems: 1,
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
            maxItems: 1,
        });
        if (await loadCurrentLink()) {
            cursor = page.tailCursor;
        }
    };

    const createGapRecovery = (): ExternalSessionFollowRefreshResult => {
        let recovery: Promise<Readonly<{ outcome: 'resync_required' }> | void> | null = null;
        return {
            outcome: 'gap_or_cursor_expired',
            recover: async () => {
                if (released || releaseRequested || isGenerationRetired()) return;
                recovery ??= trackRefreshWork(async () => {
                    const current = await loadCurrentLink();
                    if (!current) {
                        throw new ExternalSessionFollowFailureError(
                            'source_changed',
                            'External Session source changed before bounded follow resync',
                        );
                    }
                    const page = await params.providerOps.pageTranscript!({
                        source: current.source,
                        remoteSessionId: current.remoteSessionId,
                        direction: 'older',
                        maxBytes: params.maxBytes,
                        maxItems: params.maxItems,
                    });
                    const currentAfterRead = await loadCurrentLink();
                    if (!currentAfterRead || !page.tailCursor) {
                        throw new ExternalSessionFollowFailureError(
                            'source_changed',
                            'External Session source changed during bounded follow resync',
                        );
                    }
                    // This recovery is allowed exactly ONE bounded newest-page read; it can
                    // therefore only account for the gapped interval when that page IS the
                    // whole source. `truncated` means the page is not even continuous with
                    // itself, and `hasMore`/`nextCursor` mean older history exists below it
                    // that the expired cursor can no longer prove was accepted. Adopting
                    // `tailCursor` in either case would silently skip that history forever.
                    //
                    // Retain the accepted cursor and hand back the EXISTING resync_required
                    // state instead. No background page walker is introduced to preserve the
                    // shortcut.
                    if (
                        page.truncated === true
                        || page.hasMore === true
                        || (page.nextCursor !== null && page.nextCursor !== undefined)
                    ) {
                        return { outcome: 'resync_required' } as const;
                    }
                    const observedProgress =
                        deriveExternalSessionObservedProgress(page.items);
                    if (observedProgress && currentAfterRead.rawSession) {
                        await updateSessionMetadataWithObservedExternalSessionProgress({
                            token: params.credentials.token,
                            credentials: params.credentials,
                            sessionId: params.sessionId,
                            rawSession: currentAfterRead.rawSession,
                            observedProgress,
                            lastKnownActivityAtMs: observedProgress.atMs,
                            expectedLinkGeneration:
                                currentAfterRead.linkGeneration,
                        });
                    }
                    if (!await loadCurrentLink()) {
                        throw new ExternalSessionFollowFailureError(
                            'source_changed',
                            'External Session source changed before bounded follow resync commit',
                        );
                    }
                    cursor = page.tailCursor;
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
            if (released || releaseRequested || isGenerationRetired()) return;
            if (!cursor) {
                await establishCurrentTail();
                return;
            }
            const current = await loadCurrentLink();
            if (!current) return;
            const requestedCursor = cursor;
            const result = await params.providerOps.readAfterTranscript!({
                source: current.source,
                remoteSessionId: current.remoteSessionId,
                cursor: requestedCursor,
                maxBytes: params.maxBytes,
                maxItems: params.maxItems,
            });
            const currentAfterRead = await loadCurrentLink();
            if (!currentAfterRead || released || releaseRequested) return;

            if (
                result.outcome === 'gap_or_cursor_expired'
                || (
                    result.outcome === 'advanced'
                    && result.nextCursor === requestedCursor
                )
            ) {
                return createGapRecovery();
            }
            if (
                result.outcome === 'source_replaced'
                || result.outcome === 'source_unavailable'
                || result.outcome === 'read_failed'
            ) {
                return { outcome: result.outcome };
            }
            if (result.outcome === 'already_current') {
                return { outcome: 'already_current' };
            }

            const observedProgress = deriveExternalSessionObservedProgress(result.items);
            if (observedProgress && currentAfterRead.rawSession) {
                await updateSessionMetadataWithObservedExternalSessionProgress({
                    token: params.credentials.token,
                    credentials: params.credentials,
                    sessionId: params.sessionId,
                    rawSession: currentAfterRead.rawSession,
                    observedProgress,
                    lastKnownActivityAtMs: observedProgress.atMs,
                    expectedLinkGeneration: currentAfterRead.linkGeneration,
                });
            }
            if (!await loadCurrentLink()) return;
            cursor = result.nextCursor;
            return { outcome: 'advanced' };
        }),
    };
}
