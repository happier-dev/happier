import {
    reduceExternalAgentObservationEvidenceV1,
    type ExternalAgentObservationReductionV1,
} from '@happier-dev/agents';
import type {
    ExternalAgentObservationLeafFactV1,
    ExternalAgentObservationSnapshotV1,
    ExternalAgentObservationTargetV1,
} from '@happier-dev/protocol';
import { attachExternalAgentObservationTargetV1 } from '@happier-dev/protocol';

import { deepEqual } from '@/utils/deterministicJson';
import { logExternalSessionsInternalError } from '@/session/actions/externalSessions/responseErrors';

import {
    createExternalSessionObservationReconciler,
    type ExternalSessionObservationDemand,
    type ExternalSessionObservationLinkIdentity,
    type ExternalSessionObservationResourceIdentity,
} from './createExternalSessionObservationReconciler';
import type {
    ExternalSessionObservationLinkInput,
} from './resolveExternalSessionObservationLinkInput';

type ExternalSessionObservationReconciler = ReturnType<
    typeof createExternalSessionObservationReconciler
>;

const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;
const PUBLICATION_RETRY_DELAYS_MS = [250, 1_000, 4_000] as const;

type ProjectionRecord = {
    sessionId: string;
    resource: ExternalSessionObservationResourceIdentity;
    link: ExternalSessionObservationLinkIdentity;
    target: ExternalAgentObservationTargetV1;
    demand: ExternalSessionObservationDemand;
    reduction: ExternalAgentObservationReductionV1 | null;
    publicationActive: boolean;
};

type PublicationItem = Readonly<{
    record: ProjectionRecord;
    snapshot: ExternalAgentObservationSnapshotV1;
    allowAfterRecordRemoval: boolean;
}>;

type SessionPublicationState = {
    deliveredSnapshot: ExternalAgentObservationSnapshotV1 | null;
    desiredItem: PublicationItem | null;
    pump: Promise<void> | null;
    retryAttempt: number;
    retryAtMs: number | null;
    retryExhausted: boolean;
};

type ExternalSessionObservationProjectionParams = Readonly<{
    reconciler: ExternalSessionObservationReconciler;
    publishField(input: Readonly<{
        sessionId: string;
        fieldId: 'runtime.externalAgent';
        value: ExternalAgentObservationSnapshotV1;
    }>): Promise<void>;
    now?: () => number;
    setTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
}>;

function sameTarget(
    left: ExternalAgentObservationTargetV1,
    right: ExternalAgentObservationTargetV1,
): boolean {
    return deepEqual(left, right);
}

function hasObservationDemand(demand: ExternalSessionObservationDemand): boolean {
    return (
        demand.passiveEvent
        || demand.persistedPolicy
        || demand.fallbackDemand
        || demand.transcriptDemand === true
    );
}

function noObservationDemand(): ExternalSessionObservationDemand {
    return {
        passiveEvent: false,
        persistedPolicy: false,
        fallbackDemand: false,
    };
}

function observationResourceIdentityKey(
    identity: ExternalSessionObservationResourceIdentity,
): string {
    return JSON.stringify([
        identity.pluginId,
        identity.agentLocalId,
        identity.pluginGeneration,
        identity.resourceKey,
    ]);
}

/**
 * Owns the daemon's per-link External Agent reduction and publication state.
 *
 * The resource reconciler remains the sole link-key admission/pooling owner.
 * This child receives only admitted target-free facts, attaches the current
 * Happier target, reduces them through A5, and publishes through the registered
 * session-state field. It owns one process-wide earliest-expiry timer and one
 * earliest publication-retry timer.
 */
export function createExternalSessionObservationProjection(
    params: ExternalSessionObservationProjectionParams,
) {
    const now = params.now ?? Date.now;
    const setTimer = params.setTimer ?? setTimeout;
    const clearTimer = params.clearTimer ?? clearTimeout;
    const recordsBySessionId = new Map<string, ProjectionRecord>();
    const mutationTailsBySessionId = new Map<string, Promise<void>>();
    const publicationStatesBySessionId = new Map<string, SessionPublicationState>();
    const pendingPublications = new Set<Promise<void>>();
    let expiryTimer: ReturnType<typeof setTimeout> | null = null;
    let publicationRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    let disposalTail: Promise<void> | null = null;

    const isCurrentRecord = (record: ProjectionRecord): boolean => (
        !disposed
        && recordsBySessionId.get(record.sessionId) === record
    );

    const getPublicationState = (sessionId: string): SessionPublicationState => {
        const existing = publicationStatesBySessionId.get(sessionId);
        if (existing) return existing;
        const created: SessionPublicationState = {
            deliveredSnapshot: null,
            desiredItem: null,
            pump: null,
            retryAttempt: 0,
            retryAtMs: null,
            retryExhausted: false,
        };
        publicationStatesBySessionId.set(sessionId, created);
        return created;
    };

    const releasePublicationStateIfIdle = (
        sessionId: string,
        expectedState?: SessionPublicationState,
    ): void => {
        const state = publicationStatesBySessionId.get(sessionId);
        if (
            !state
            || (expectedState && state !== expectedState)
            || state.pump
            || state.desiredItem
            || recordsBySessionId.has(sessionId)
        ) {
            return;
        }
        publicationStatesBySessionId.delete(sessionId);
    };

    const schedulePublicationRetries = (): void => {
        if (publicationRetryTimer) {
            clearTimer(publicationRetryTimer);
            publicationRetryTimer = null;
        }
        if (disposed) return;

        let earliestRetryAtMs: number | null = null;
        for (const state of publicationStatesBySessionId.values()) {
            if (
                state.retryAtMs !== null
                && (
                    earliestRetryAtMs === null
                    || state.retryAtMs < earliestRetryAtMs
                )
            ) {
                earliestRetryAtMs = state.retryAtMs;
            }
        }
        if (earliestRetryAtMs === null) return;

        publicationRetryTimer = setTimer(() => {
            publicationRetryTimer = null;
            if (disposed) return;
            const observedNowMs = now();
            for (const [sessionId, state] of publicationStatesBySessionId) {
                if (
                    state.retryAtMs === null
                    || state.retryAtMs > observedNowMs
                ) {
                    continue;
                }
                state.retryAtMs = null;
                pumpPublications(sessionId, state);
            }
            schedulePublicationRetries();
        }, Math.min(
            MAX_NODE_TIMER_DELAY_MS,
            Math.max(0, earliestRetryAtMs - now()),
        ));
        publicationRetryTimer.unref?.();
    };

    const pumpPublications = (
        sessionId: string,
        state: SessionPublicationState,
    ): void => {
        if (
            state.pump
            || disposed
            || state.retryAtMs !== null
            || state.retryExhausted
        ) {
            return;
        }
        const item = state.desiredItem;
        if (!item) {
            releasePublicationStateIfIdle(sessionId, state);
            return;
        }
        if (
            !item.allowAfterRecordRemoval
            && !isCurrentRecord(item.record)
        ) {
            if (state.desiredItem === item) {
                state.desiredItem = null;
                state.retryAttempt = 0;
            }
            releasePublicationStateIfIdle(sessionId, state);
            return;
        }
        if (deepEqual(state.deliveredSnapshot, item.snapshot)) {
            if (state.desiredItem === item) {
                state.desiredItem = null;
                state.retryAttempt = 0;
            }
            releasePublicationStateIfIdle(sessionId, state);
            return;
        }
        let pump: Promise<void>;
        let retryScheduleChanged = false;
        pump = (async () => {
            try {
                await params.publishField({
                    sessionId,
                    fieldId: 'runtime.externalAgent',
                    value: item.snapshot,
                });
                state.deliveredSnapshot = item.snapshot;
                if (state.desiredItem === item) {
                    state.desiredItem = null;
                }
                state.retryAttempt = 0;
                state.retryAtMs = null;
                state.retryExhausted = false;
            } catch (error) {
                logExternalSessionsInternalError(
                    'external_session.observation_publication',
                    error,
                );
                if (
                    disposed
                    || state.desiredItem !== item
                ) {
                    state.retryAttempt = 0;
                    state.retryAtMs = null;
                    state.retryExhausted = false;
                    return;
                }
                const retryDelayMs =
                    PUBLICATION_RETRY_DELAYS_MS[state.retryAttempt];
                if (retryDelayMs === undefined) {
                    state.retryExhausted = true;
                    return;
                }
                state.retryAttempt += 1;
                state.retryAtMs = now() + retryDelayMs;
                retryScheduleChanged = true;
            }
        })().finally(() => {
            pendingPublications.delete(pump);
            if (state.pump === pump) {
                state.pump = null;
            }
            if (retryScheduleChanged) {
                schedulePublicationRetries();
            }
            if (
                state.desiredItem
                && state.retryAtMs === null
                && !state.retryExhausted
                && !disposed
            ) {
                pumpPublications(sessionId, state);
            }
            releasePublicationStateIfIdle(sessionId, state);
        });
        state.pump = pump;
        pendingPublications.add(pump);
    };

    const trackPublication = (
        record: ProjectionRecord,
        snapshot: ExternalAgentObservationSnapshotV1,
        options?: Readonly<{ allowAfterRecordRemoval?: boolean }>,
    ): void => {
        if (!isCurrentRecord(record) && options?.allowAfterRecordRemoval !== true) {
            return;
        }
        record.publicationActive = true;
        const state = getPublicationState(record.sessionId);
        if (deepEqual(state.desiredItem?.snapshot, snapshot)) {
            if (options?.allowAfterRecordRemoval !== true) {
                state.desiredItem = {
                    record,
                    snapshot,
                    allowAfterRecordRemoval: false,
                };
            }
            if (
                state.retryExhausted
                && options?.allowAfterRecordRemoval !== true
            ) {
                state.retryAttempt = 0;
                state.retryExhausted = false;
                pumpPublications(record.sessionId, state);
            }
            return;
        }
        if (
            !state.desiredItem
            && deepEqual(state.deliveredSnapshot, snapshot)
        ) {
            return;
        }
        const cancelledScheduledRetry = state.retryAtMs !== null;
        state.desiredItem = {
            record,
            snapshot,
            allowAfterRecordRemoval: options?.allowAfterRecordRemoval === true,
        };
        state.retryAttempt = 0;
        state.retryAtMs = null;
        state.retryExhausted = false;
        if (cancelledScheduledRetry) {
            schedulePublicationRetries();
        }
        pumpPublications(record.sessionId, state);
    };

    const cancelRemovedRecordPublication = (
        record: ProjectionRecord,
    ): void => {
        const state = publicationStatesBySessionId.get(record.sessionId);
        if (
            !state?.desiredItem
            || state.desiredItem.record !== record
            || state.desiredItem.allowAfterRecordRemoval
        ) {
            return;
        }
        const cancelledScheduledRetry = state.retryAtMs !== null;
        state.desiredItem = null;
        state.retryAttempt = 0;
        state.retryAtMs = null;
        state.retryExhausted = false;
        if (cancelledScheduledRetry) {
            schedulePublicationRetries();
        }
        releasePublicationStateIfIdle(record.sessionId, state);
    };

    const reduceRecordToUnknown = (
        record: ProjectionRecord,
    ): ExternalAgentObservationSnapshotV1 | null => {
        if (!record.reduction) return null;
        if (record.reduction.snapshot.status === 'unknown') {
            return record.reduction.snapshot;
        }
        // Link removal revokes every fact owned by that link immediately.
        // Feeding an `unsupported` fact through the ordinary reducer would
        // leave a still-fresh, higher-authority Agent-native fact visible.
        return {
            v: 1,
            ...record.target,
            status: 'unknown',
        };
    };

    const failClosedAndRemoveRecord = (
        record: ProjectionRecord,
        options?: Readonly<{ allowAlreadyRemoved?: boolean }>,
    ): void => {
        const current = recordsBySessionId.get(record.sessionId);
        if (
            current !== record
            && !(
                options?.allowAlreadyRemoved === true
                && current === undefined
            )
        ) {
            return;
        }
        const unknown = reduceRecordToUnknown(record);
        if (unknown && record.publicationActive) {
            trackPublication(record, unknown, { allowAfterRecordRemoval: true });
        }
        if (current === record) {
            recordsBySessionId.delete(record.sessionId);
        }
        cancelRemovedRecordPublication(record);
        releasePublicationStateIfIdle(record.sessionId);
        scheduleExpiry();
    };

    const scheduleExpiry = (): void => {
        if (expiryTimer) {
            clearTimer(expiryTimer);
            expiryTimer = null;
        }
        if (disposed) return;

        let earliestExpiryAtMs: number | undefined;
        for (const record of recordsBySessionId.values()) {
            const candidate = record.reduction?.nextExpiryAtMs;
            if (
                candidate !== undefined
                && (earliestExpiryAtMs === undefined || candidate < earliestExpiryAtMs)
            ) {
                earliestExpiryAtMs = candidate;
            }
        }
        if (earliestExpiryAtMs === undefined) return;

        expiryTimer = setTimer(() => {
            expiryTimer = null;
            if (disposed) return;
            const observedNowMs = now();
            for (const record of recordsBySessionId.values()) {
                if (
                    record.reduction?.nextExpiryAtMs === undefined
                    || record.reduction.nextExpiryAtMs > observedNowMs
                ) {
                    continue;
                }
                record.reduction = reduceExternalAgentObservationEvidenceV1({
                    target: record.target,
                    current: record.reduction,
                    evidence: [],
                    nowMs: observedNowMs,
                });
                const shouldReleaseInertRecord = (
                    record.reduction.snapshot.status === 'unknown'
                    && record.reduction.nextExpiryAtMs === undefined
                    && !hasObservationDemand(record.demand)
                );
                if (record.publicationActive) {
                    trackPublication(record, record.reduction.snapshot, {
                        allowAfterRecordRemoval: shouldReleaseInertRecord,
                    });
                }
                if (shouldReleaseInertRecord) {
                    recordsBySessionId.delete(record.sessionId);
                    releasePublicationStateIfIdle(record.sessionId);
                }
            }
            scheduleExpiry();
        }, Math.min(
            MAX_NODE_TIMER_DELAY_MS,
            Math.max(0, earliestExpiryAtMs - now()),
        ));
    };

    const acceptFacts = (
        record: ProjectionRecord,
        facts: readonly ExternalAgentObservationLeafFactV1[],
    ): void => {
        if (!isCurrentRecord(record) || facts.length === 0) return;
        const evidence = attachExternalAgentObservationTargetV1(
            record.target,
            facts,
        );
        record.reduction = reduceExternalAgentObservationEvidenceV1({
            target: record.target,
            current: record.reduction,
            evidence,
            nowMs: now(),
        });
        if (hasObservationDemand(record.demand)) {
            trackPublication(record, record.reduction.snapshot);
        }
        scheduleExpiry();
    };

    const removeProjectionRecord = (
        sessionId: string,
        expected?: ExternalSessionObservationLinkIdentity,
    ): void => {
        const record = recordsBySessionId.get(sessionId);
        if (!record) return;
        if (
            expected
            && (
                record.link.linkGeneration !== expected.linkGeneration
                || record.link.linkKey !== expected.linkKey
            )
        ) {
            return;
        }
        recordsBySessionId.delete(sessionId);
        cancelRemovedRecordPublication(record);
        releasePublicationStateIfIdle(sessionId);
        scheduleExpiry();
    };

    const runSerialized = async <T>(
        sessionId: string,
        operation: () => Promise<T>,
    ): Promise<T> => {
        const previous = mutationTailsBySessionId.get(sessionId) ?? Promise.resolve();
        let releaseTail: () => void = () => {};
        const current = new Promise<void>((resolve) => {
            releaseTail = resolve;
        });
        const tail = previous.catch(() => undefined).then(() => current);
        mutationTailsBySessionId.set(sessionId, tail);
        await previous.catch(() => undefined);
        try {
            return await operation();
        } finally {
            releaseTail();
            if (mutationTailsBySessionId.get(sessionId) === tail) {
                mutationTailsBySessionId.delete(sessionId);
            }
        }
    };

    type ReconcileLinkInput = Readonly<{
        resource: ExternalSessionObservationResourceIdentity;
        link: ExternalSessionObservationLinkIdentity;
        target: ExternalAgentObservationTargetV1;
        demand: ExternalSessionObservationDemand;
    }>;

    const reconcileLinkNow = async (
        input: ReconcileLinkInput,
        persistDemand: boolean,
        awaitObserverAdmission = false,
    ) => {
        if (disposed) {
            return { state: 'disposed' } as const;
        }
        const existing = recordsBySessionId.get(input.link.sessionId) ?? null;
        const record = existing
            && existing.link.linkGeneration === input.link.linkGeneration
            && existing.link.linkKey === input.link.linkKey
            && sameTarget(existing.target, input.target)
            ? existing
            : {
                sessionId: input.link.sessionId,
                resource: input.resource,
                link: input.link,
                target: input.target,
                demand: persistDemand ? input.demand : noObservationDemand(),
                reduction: null,
                publicationActive: false,
            };

        if (record !== existing) {
            if (existing) {
                failClosedAndRemoveRecord(existing);
            }
            recordsBySessionId.set(input.link.sessionId, record);
            scheduleExpiry();
        } else {
            record.resource = input.resource;
            record.link = input.link;
            if (persistDemand) {
                record.demand = input.demand;
            }
        }

        const result = await params.reconciler.reconcileLink({
            resource: input.resource,
            link: input.link,
            demand: input.demand,
            onFacts: (facts) => acceptFacts(record, facts),
            ...(awaitObserverAdmission ? { awaitObserverAdmission: true } : {}),
        });
        if (
            result.state !== 'observing'
            && result.state !== 'reconcile-only'
        ) {
            if (
                result.state === 'not-demanded'
                && record.reduction?.nextExpiryAtMs !== undefined
            ) {
                record.demand = input.demand;
                scheduleExpiry();
            } else if (record.reduction) {
                failClosedAndRemoveRecord(record);
            } else {
                removeProjectionRecord(input.link.sessionId, input.link);
            }
        }
        return result;
    };

    const reconcileFallbackDemandNow = async (input: Readonly<{
        sessionId: string;
        linkGeneration: string;
        resolved: ExternalSessionObservationLinkInput | null;
        demanded: boolean;
    }>) => {
        const existing = recordsBySessionId.get(input.sessionId) ?? null;
        const matchingExisting = existing?.link.linkGeneration === input.linkGeneration
            ? existing
            : null;
        if (
            !input.demanded
            || !input.resolved
        ) {
            if (!matchingExisting) {
                return { state: 'not-demanded' } as const;
            }
            return await reconcileLinkNow({
                resource: matchingExisting.resource,
                link: matchingExisting.link,
                target: matchingExisting.target,
                demand: {
                    ...matchingExisting.demand,
                    fallbackDemand: false,
                },
            }, true);
        }
        if (
            input.resolved.link.sessionId !== input.sessionId
            || input.resolved.link.linkGeneration !== input.linkGeneration
        ) {
            return { state: 'stale-link' } as const;
        }
        return await reconcileLinkNow({
            ...input.resolved,
            demand: {
                ...(matchingExisting?.demand ?? noObservationDemand()),
                fallbackDemand: true,
            },
        }, true);
    };

    const reconcileTranscriptDemandNow = async (input: Readonly<{
        resolved: ExternalSessionObservationLinkInput;
        demanded: boolean;
    }>) => {
        const sessionId = input.resolved.link.sessionId;
        const existing = recordsBySessionId.get(sessionId) ?? null;
        const matchingExisting = existing
            && existing.link.linkGeneration === input.resolved.link.linkGeneration
            && existing.link.linkKey === input.resolved.link.linkKey
            && sameTarget(existing.target, input.resolved.target)
            ? existing
            : null;

        if (!input.demanded) {
            if (!matchingExisting) {
                return { state: 'not-demanded' } as const;
            }
            return await reconcileLinkNow({
                resource: matchingExisting.resource,
                link: matchingExisting.link,
                target: matchingExisting.target,
                demand: {
                    passiveEvent: matchingExisting.demand.passiveEvent,
                    persistedPolicy: matchingExisting.demand.persistedPolicy,
                    fallbackDemand: matchingExisting.demand.fallbackDemand,
                },
            }, true);
        }

        return await reconcileLinkNow({
            ...input.resolved,
            demand: {
                ...(matchingExisting?.demand ?? noObservationDemand()),
                transcriptDemand: true,
            },
        }, true, true);
    };

    const removeLinkNow = async (
        link: ExternalSessionObservationLinkIdentity,
        releaseOnlyLocalCustody: boolean,
    ) => {
        const record = recordsBySessionId.get(link.sessionId);
        const ownsMatchingProjection = Boolean(
            record
            && record.link.linkGeneration === link.linkGeneration
            && record.link.linkKey === link.linkKey,
        );
        const preservesDurableObservation = Boolean(
            releaseOnlyLocalCustody
            && record
            && ownsMatchingProjection
            && record.resource.retirementSignal?.aborted !== true,
        );
        if (record && preservesDurableObservation) {
            // Local daemon/account custody ends without changing the Account's
            // last durable fact. Remove the record before observer disposal so
            // a disposal-time callback cannot enqueue a late publication.
            removeProjectionRecord(link.sessionId, link);
        }
        const result = await params.reconciler.removeLink(link);
        const retiredDuringLocalRelease = Boolean(
            preservesDurableObservation
            && record?.resource.retirementSignal?.aborted === true,
        );
        if (
            record
            && ownsMatchingProjection
            && (!preservesDurableObservation || retiredDuringLocalRelease)
        ) {
            // Semantic retirement wins even when a later local pause/account
            // rotation requested release while waiting for this serialized
            // owner. Publish the matching link's fail-closed terminal fact.
            failClosedAndRemoveRecord(record, {
                allowAlreadyRemoved: retiredDuringLocalRelease,
            });
        }
        return {
            removed: result.removed || ownsMatchingProjection,
        } as const;
    };

    const api = {
        resolveQualifiedCurrentLink(input: Readonly<{
            qualifiedIdentity:
                ExternalAgentObservationTargetV1['qualifiedLinkIdentity'];
            source:
                ExternalSessionObservationLinkIdentity['linkedSource']['source'];
            remoteSessionId: string;
            linkData?:
                ExternalSessionObservationLinkIdentity['linkedSource']['linkData'];
        }>): Readonly<{
            sessionId: string;
            linkGeneration: string;
        }> | null {
            if (disposed) return null;
            const matches = [...recordsBySessionId.values()].filter((record) => (
                deepEqual(
                    record.target.qualifiedLinkIdentity,
                    input.qualifiedIdentity,
                )
                && deepEqual(record.link.linkedSource.source, input.source)
                && record.link.linkedSource.remoteSessionId
                    === input.remoteSessionId
                && deepEqual(
                    record.link.linkedSource.linkData ?? {},
                    input.linkData ?? {},
                )
            ));
            if (matches.length !== 1) return null;
            const [record] = matches;
            return {
                sessionId: record.sessionId,
                linkGeneration: record.link.linkGeneration,
            };
        },

        async admitQualifiedFactsForCurrentLink(input: Readonly<{
            resolved: ExternalSessionObservationLinkInput;
            facts: readonly ExternalAgentObservationLeafFactV1[];
            shouldCommit?: () => boolean;
        }>): Promise<boolean> {
            const sessionId = input.resolved.link.sessionId;
            return await runSerialized(sessionId, async () => {
                if (
                    disposed
                    || (input.shouldCommit && !input.shouldCommit())
                    || input.resolved.target.linkGeneration
                        !== input.resolved.link.linkGeneration
                ) {
                    return false;
                }
                if (input.facts.length === 0) return true;

                const existing = recordsBySessionId.get(sessionId) ?? null;
                const record = existing
                    && existing.link.linkGeneration
                        === input.resolved.link.linkGeneration
                    && existing.link.linkKey === input.resolved.link.linkKey
                    && sameTarget(existing.target, input.resolved.target)
                    ? existing
                    : {
                        sessionId,
                        resource: input.resolved.resource,
                        link: input.resolved.link,
                        target: input.resolved.target,
                        demand: noObservationDemand(),
                        reduction: null,
                        publicationActive: false,
                    };

                if (record !== existing) {
                    if (existing) failClosedAndRemoveRecord(existing);
                    recordsBySessionId.set(sessionId, record);
                } else {
                    record.resource = input.resolved.resource;
                    record.link = input.resolved.link;
                }

                acceptFacts(record, input.facts);
                if (
                    record.reduction
                    && isCurrentRecord(record)
                    && (!input.shouldCommit || input.shouldCommit())
                ) {
                    trackPublication(record, record.reduction.snapshot);
                    return true;
                }
                return false;
            });
        },

        async admitQualifiedFacts(input: Readonly<{
            sessionId: string;
            target: ExternalAgentObservationTargetV1;
            facts: readonly ExternalAgentObservationLeafFactV1[];
            shouldCommit?: () => boolean;
        }>): Promise<boolean> {
            return await runSerialized(input.sessionId, async () => {
                if (input.shouldCommit && !input.shouldCommit()) {
                    return false;
                }
                const record = recordsBySessionId.get(input.sessionId);
                if (
                    !record
                    || !sameTarget(record.target, input.target)
                ) {
                    return false;
                }
                acceptFacts(record, input.facts);
                return true;
            });
        },

        async reconcileLink(input: ReconcileLinkInput) {
            return await runSerialized(
                input.link.sessionId,
                async () => {
                    const existing = recordsBySessionId.get(
                        input.link.sessionId,
                    ) ?? null;
                    const preservesCurrentFallbackAxis = Boolean(
                        existing
                        && existing.link.linkGeneration
                            === input.link.linkGeneration
                        && existing.link.linkKey === input.link.linkKey
                        && sameTarget(existing.target, input.target),
                    );
                    const transcriptDemand = input.demand.transcriptDemand === true
                        || (
                            preservesCurrentFallbackAxis
                            && existing!.demand.transcriptDemand === true
                        );
                    return await reconcileLinkNow({
                        ...input,
                        demand: {
                            ...input.demand,
                            // Passive restoration owns only the passive/persisted
                            // axes. Fallback demand is cleared exclusively through
                            // reconcileFallbackDemandBatch.
                            fallbackDemand:
                                input.demand.fallbackDemand
                                || (
                                    preservesCurrentFallbackAxis
                                    && existing!.demand.fallbackDemand
                                ),
                            // Transcript demand is owned and cleared only by
                            // reconcileTranscriptDemand. Status/passive
                            // reconciliation cannot overwrite that axis.
                            ...(transcriptDemand ? { transcriptDemand: true } : {}),
                        },
                    }, true);
                },
            );
        },

        async reconcileTranscriptDemand(input: Readonly<{
            resolved: ExternalSessionObservationLinkInput;
            demanded: boolean;
        }>) {
            return await runSerialized(
                input.resolved.link.sessionId,
                async () => await reconcileTranscriptDemandNow(input),
            );
        },

        async reconcileFallbackDemandBatch(inputs: readonly Readonly<{
            sessionId: string;
            linkGeneration: string;
            resolved: ExternalSessionObservationLinkInput | null;
            demanded: boolean;
        }>[]): Promise<void> {
            const resources = new Map<
                string,
                ExternalSessionObservationResourceIdentity
            >();
            const admissions = await Promise.allSettled(inputs.map(async (input) => {
                const result = await runSerialized(
                    input.sessionId,
                    async () => await reconcileFallbackDemandNow(input),
                );
                if (
                    input.demanded
                    && input.resolved
                    && (result.state === 'observing' || result.state === 'reconcile-only')
                ) {
                    resources.set(
                        observationResourceIdentityKey(input.resolved.resource),
                        input.resolved.resource,
                    );
                }
            }));
            const reconciliations = await Promise.allSettled(
                [...resources.values()].map(async (resource) => {
                    await params.reconciler.reconcileResource(resource);
                }),
            );
            const failure = [...admissions, ...reconciliations]
                .find((result) => result.status === 'rejected');
            if (failure?.status === 'rejected') {
                throw failure.reason;
            }
        },

        async reconcileStatusLink(input: Readonly<{
            resource: ExternalSessionObservationResourceIdentity;
            link: ExternalSessionObservationLinkIdentity;
            target: ExternalAgentObservationTargetV1;
        }>) {
            return await runSerialized(input.link.sessionId, async () => {
                const existing = recordsBySessionId.get(input.link.sessionId) ?? null;
                const hasMatchingBaseline = Boolean(
                    existing
                    && existing.link.linkGeneration === input.link.linkGeneration
                    && existing.link.linkKey === input.link.linkKey
                    && sameTarget(existing.target, input.target),
                );
                const baselineDemand: ExternalSessionObservationDemand = hasMatchingBaseline
                    ? existing!.demand
                    : noObservationDemand();
                const baselineReduction = hasMatchingBaseline
                    ? existing!.reduction
                    : null;
                const temporaryDemand: ExternalSessionObservationDemand = {
                    ...baselineDemand,
                    fallbackDemand: true,
                };
                try {
                    const admitted = await reconcileLinkNow({
                        ...input,
                        demand: temporaryDemand,
                    }, false);
                    if (
                        admitted.state !== 'observing'
                        && admitted.state !== 'reconcile-only'
                    ) {
                        return {
                            reconciliation: { state: admitted.state },
                            snapshot: null,
                        } as const;
                    }

                    const reconciliation = await params.reconciler.reconcileResource(
                        input.resource,
                    );
                    const snapshot = recordsBySessionId.get(input.link.sessionId)
                        ?.reduction?.snapshot ?? null;
                    return { reconciliation, snapshot } as const;
                } finally {
                    if (hasObservationDemand(baselineDemand)) {
                        await reconcileLinkNow({
                            ...input,
                            demand: baselineDemand,
                        }, true);
                    } else {
                        await params.reconciler.removeLink(input.link);
                        const record = recordsBySessionId.get(input.link.sessionId);
                        if (
                            hasMatchingBaseline
                            && record
                            && baselineReduction?.nextExpiryAtMs !== undefined
                        ) {
                            record.demand = baselineDemand;
                            record.reduction = baselineReduction;
                            scheduleExpiry();
                        } else {
                            removeProjectionRecord(input.link.sessionId, input.link);
                        }
                    }
                }
            });
        },

        async reconcileResource(
            resource: ExternalSessionObservationResourceIdentity,
        ) {
            return await params.reconciler.reconcileResource(resource);
        },

        readSnapshot(sessionId: string): ExternalAgentObservationSnapshotV1 | null {
            return recordsBySessionId.get(sessionId)?.reduction?.snapshot ?? null;
        },

        async removeLink(link: ExternalSessionObservationLinkIdentity) {
            return await runSerialized(
                link.sessionId,
                async () => await removeLinkNow(link, false),
            );
        },

        async releaseLink(link: ExternalSessionObservationLinkIdentity) {
            return await runSerialized(
                link.sessionId,
                async () => await removeLinkNow(link, true),
            );
        },

        async flush(): Promise<void> {
            while (pendingPublications.size > 0) {
                await Promise.all([...pendingPublications]);
            }
        },

        async dispose(): Promise<void> {
            // Terminal intent is recorded first and stays fail-closed, but the
            // fallible tail below must remain retryable: the reconciler deliberately
            // retains an observer whose disposal rejected so the exact same cleanup
            // can be retried. Returning early on the next call would strand it.
            disposed = true;
            if (expiryTimer) {
                clearTimer(expiryTimer);
                expiryTimer = null;
            }
            if (publicationRetryTimer) {
                clearTimer(publicationRetryTimer);
                publicationRetryTimer = null;
            }
            recordsBySessionId.clear();
            for (const state of publicationStatesBySessionId.values()) {
                state.desiredItem = null;
                state.retryAtMs = null;
                state.retryExhausted = false;
            }
            const attempt = disposalTail ??= (async () => {
                await params.reconciler.dispose();
                await Promise.all([...mutationTailsBySessionId.values()]);
                await Promise.all([...pendingPublications]);
                publicationStatesBySessionId.clear();
            })();
            try {
                await attempt;
            } catch (error) {
                if (disposalTail === attempt) {
                    disposalTail = null;
                }
                throw error;
            }
        },
    };
    return api;
}
