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
import type { Credentials } from '@/persistence';
import type { ExternalSessionExecutionSurface } from '@/session/external/providerOps';
import { deepEqual } from '@/utils/deterministicJson';

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
    credentials: Credentials;
}>): Promise<ExternalSessionFollowLease> {
    const isGenerationRetired = (): boolean =>
        params.resource.retirementSignal?.aborted === true;
    if (!params.providerOps.pageTranscript || !params.providerOps.readAfterTranscript) {
        throw new Error('Canonical External Session transcript reads are unavailable');
    }
    if (
        params.observation.resource.pluginGeneration !== params.resource.pluginGeneration
        || params.observation.link.linkGeneration !== params.resource.linkGeneration
        || isGenerationRetired()
    ) {
        throw new Error('External Session follow generation changed before acquisition');
    }

    let cursor = params.initialCursor?.trim() || null;
    let released = false;
    let releasePromise: Promise<void> | null = null;
    const inFlightRefreshWork = new Set<Promise<unknown>>();
    const trackRefreshWork = <T>(operation: () => Promise<T>): Promise<T> => {
        let tracked!: Promise<T>;
        tracked = operation().finally(() => {
            inFlightRefreshWork.delete(tracked);
        });
        inFlightRefreshWork.add(tracked);
        return tracked;
    };
    const release = (): Promise<void> => {
        if (releasePromise) return releasePromise;
        released = true;
        releasePromise = (async () => {
            await params.observationProjection.reconcileTranscriptDemand({
                resolved: params.observation,
                demanded: false,
            }).catch(() => undefined);
            while (inFlightRefreshWork.size > 0) {
                await Promise.allSettled([...inFlightRefreshWork]);
            }
        })();
        return releasePromise;
    };
    let admitted: Readonly<{ state: string }>;
    try {
        admitted = await params.observationProjection.reconcileTranscriptDemand({
            resolved: params.observation,
            demanded: true,
        });
        if (admitted.state !== 'observing') {
            throw new Error(
                `External Session live follow is unavailable: ${admitted.state}`,
            );
        }
    } catch (error) {
        await release();
        throw error;
    }
    if (isGenerationRetired()) {
        await release();
        throw new Error('External Session follow generation retired during acquisition');
    }
    if (!cursor) {
        try {
            const baseline = await params.providerOps.pageTranscript({
                source: params.linked.source,
                remoteSessionId: params.linked.remoteSessionId,
                direction: 'older',
                maxBytes: params.maxBytes,
                maxItems: 1,
            });
            cursor = baseline.tailCursor;
        } catch (error) {
            await release();
            throw error;
        }
    }
    if (isGenerationRetired()) {
        await release();
        throw new Error('External Session follow generation retired during acquisition');
    }

    const loadCurrentLink = async (): Promise<LoadedLinkedExternalSession | null> => {
        if (released || isGenerationRetired()) return null;
        const loaded = await loadLinkedExternalSession({
            credentials: params.credentials,
            sessionId: params.sessionId,
            machineId: params.machineId,
            expectedHostedIdentity: {
                agentId: params.linked.agentId,
                machineId: params.linked.machineId,
                remoteSessionId: params.linked.remoteSessionId,
                source: params.linked.source,
            },
        }).catch(() => null);
        if (
            released
            || isGenerationRetired()
            || !loaded?.ok
            || loaded.session.linkGeneration !== params.resource.linkGeneration
            || loaded.session.agentId !== params.linked.agentId
            || loaded.session.remoteSessionId !== params.linked.remoteSessionId
            || !deepEqual(loaded.session.source, params.linked.source)
        ) {
            return null;
        }
        return loaded.session;
    };

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
        let recovery: Promise<void> | null = null;
        return {
            outcome: 'gap_or_cursor_expired',
            recover: async () => {
                if (released || isGenerationRetired()) return;
                recovery ??= trackRefreshWork(async () => {
                    const current = await loadCurrentLink();
                    if (!current) {
                        throw new Error(
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
                        throw new Error(
                            'External Session source changed during bounded follow resync',
                        );
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
                        });
                    }
                    if (!await loadCurrentLink()) {
                        throw new Error(
                            'External Session source changed before bounded follow resync commit',
                        );
                    }
                    cursor = page.tailCursor;
                });
                await recovery;
            },
        };
    };

    return {
        release,
        readAcceptedCursor: () => cursor,
        requestTranscriptRefresh: () => trackRefreshWork(async () => {
            if (released || isGenerationRetired()) return;
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
            if (!currentAfterRead || released) return;

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
                });
            }
            if (!await loadCurrentLink()) return;
            cursor = result.nextCursor;
            return { outcome: 'advanced' };
        }),
    };
}
