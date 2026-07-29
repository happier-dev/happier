import type {
    ExternalSessionFollowIssueV1,
    ExternalSessionFollowStatusV1,
} from '@happier-dev/protocol';

import { logger } from '@/utils/logger';

import { createExternalSessionViewerLeaseRegistry } from './externalSessionViewerLeaseRegistry';

export type ExternalSessionFollowRefreshResult =
    | Readonly<{ outcome: 'already_current' | 'advanced' }>
    | Readonly<{
        outcome: 'gap_or_cursor_expired';
        recover: () => Promise<void>;
    }>
    | Readonly<{
        outcome: 'source_replaced' | 'source_unavailable' | 'read_failed';
    }>;

export type ExternalSessionFollowLease = Readonly<{
    release: () => Promise<void>;
    readAcceptedCursor?: () => string | null;
    requestTranscriptRefresh?: () => Promise<ExternalSessionFollowRefreshResult | void>;
}>;

export type ExternalSessionFollowResource = Readonly<{
    linkGeneration: string;
    pluginGeneration: string;
    retirementSignal?: AbortSignal;
}>;

type FollowLeaseAcquirer = (
    initialCursor?: string | null,
) => Promise<ExternalSessionFollowLease | null>;
type CursorRefreshRequester = (
    cursor: string,
    isCurrent: () => boolean,
) => Promise<ExternalSessionFollowRefreshResult | void>;

type ViewerLeaseRecord = {
    sessionId: string;
    leaseId: string;
    acceptedTailCursor: string | null;
    requestTranscriptRefresh: CursorRefreshRequester | null;
    refreshDelivery: 'session_invalidation' | 'scoped_listener';
    expiryTimer: ReturnType<typeof setTimeout> | null;
};

type DesiredFollowSource = {
    key: string;
    resource: ExternalSessionFollowResource | null;
    acquireFollowLease: FollowLeaseAcquirer | null;
    requestTranscriptRefresh: CursorRefreshRequester | null;
    removeRetirementListener: (() => void) | null;
};

type ActualFollowRecord = {
    key: string;
    release: () => Promise<void>;
    readAcceptedCursor: (() => string | null) | null;
    requestTranscriptRefresh:
        (() => Promise<ExternalSessionFollowRefreshResult | void>) | null;
    released: boolean;
};

type ActualReleaseResult = 'none' | 'released' | 'retained' | 'fenced';

type SessionFollowState = {
    source: DesiredFollowSource | null;
    actual: ActualFollowRecord | null;
    acquisitionKey: string | null;
    authorityEpoch: number;
    suspensionReasons: Set<string>;
    refreshIssueCode: string | null;
    refreshInFlight: Promise<void> | null;
    refreshPending: boolean;
    reacquisitionCursor: string | null;
};

type ExternalSessionFollowLeaseManagerParams = Readonly<{
    now?: () => number;
    randomId?: () => string;
    setTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
    writeFollowStatus?: (input: Readonly<{
        sessionId: string;
        followStatusV1: ExternalSessionFollowStatusV1;
        lastFollowIssueV1?: ExternalSessionFollowIssueV1;
    }>) => Promise<void>;
}>;

function resourceKey(resource: ExternalSessionFollowResource | undefined): string {
    return resource
        ? JSON.stringify([resource.linkGeneration, resource.pluginGeneration])
        : 'legacy';
}

function viewerLeaseKey(sessionId: string, leaseId: string): string {
    return JSON.stringify([sessionId, leaseId]);
}

export function createExternalSessionFollowLeaseManager(params?: ExternalSessionFollowLeaseManagerParams) {
    const now = params?.now ?? Date.now;
    const setTimer = params?.setTimer ?? setTimeout;
    const clearTimer = params?.clearTimer ?? clearTimeout;
    const viewerLeaseRegistry = createExternalSessionViewerLeaseRegistry({
        now,
        randomId: params?.randomId,
    });
    const viewerLeasesById = new Map<string, ViewerLeaseRecord>();
    const backgroundFollowEnabledBySessionId = new Map<string, boolean>();
    const statesBySessionId = new Map<string, SessionFollowState>();
    let disposed = false;
    let operations = Promise.resolve();

    const runExclusive = <T>(operation: () => Promise<T>): Promise<T> => {
        const result = operations.then(operation, operation);
        operations = result.then(() => undefined, () => undefined);
        return result;
    };

    const stateFor = (sessionId: string): SessionFollowState => {
        const existing = statesBySessionId.get(sessionId);
        if (existing) return existing;
        const created: SessionFollowState = {
            source: null,
            actual: null,
            acquisitionKey: null,
            authorityEpoch: 0,
            suspensionReasons: new Set(),
            refreshIssueCode: null,
            refreshInFlight: null,
            refreshPending: false,
            reacquisitionCursor: null,
        };
        statesBySessionId.set(sessionId, created);
        return created;
    };

    const publishFollowStatus = async (
        sessionId: string,
        status: ExternalSessionFollowStatusV1['status'],
        reason: string,
        lastFollowIssueV1?: ExternalSessionFollowIssueV1,
        updatedAtMs = now(),
    ): Promise<void> => {
        if (!params?.writeFollowStatus) return;
        try {
            await params.writeFollowStatus({
                sessionId,
                followStatusV1: { v: 1, status, reason, updatedAtMs },
                ...(lastFollowIssueV1 === undefined ? {} : { lastFollowIssueV1 }),
            });
        } catch {
            logger.debug('[externalSessions.follow] Follow-status metadata write failed (non-fatal)', {
                sessionId,
                status,
                reason,
            });
        }
    };

    const publishFollowFailure = async (
        sessionId: string,
        operation: 'acquire' | 'release',
        unavailable = false,
    ): Promise<void> => {
        const observedAtMs = now();
        const reason = unavailable ? 'lease_unavailable' : `lease_${operation}_failed`;
        await publishFollowStatus(sessionId, 'error', reason, {
            v: 1,
            code: unavailable ? 'follow_lease_unavailable' : `follow_lease_${operation}_failed`,
            retryable: true,
            observedAtMs,
        }, observedAtMs);
    };

    const releaseActual = async (
        sessionId: string,
        state: SessionFollowState,
        transition: Readonly<{ status: 'disabled' | 'paused'; reason: string }>,
        failureFence?:
            | Readonly<{ kind: 'manager_terminal' }>
            | Readonly<{ kind: 'source_retired'; key: string }>,
    ): Promise<ActualReleaseResult> => {
        const actual = state.actual;
        if (!actual) return 'none';
        state.refreshPending = false;
        if (actual.released) return 'retained';
        actual.released = true;
        try {
            await actual.release();
        } catch {
            const fenced = failureFence?.kind === 'manager_terminal'
                || (
                    failureFence?.kind === 'source_retired'
                    && failureFence.key === actual.key
                );
            if (fenced) {
                if (state.actual === actual) state.actual = null;
            } else {
                actual.released = false;
            }
            await publishFollowFailure(sessionId, 'release');
            return fenced ? 'fenced' : 'retained';
        }
        if (state.actual === actual) state.actual = null;
        await publishFollowStatus(sessionId, transition.status, transition.reason);
        return 'released';
    };

    const hasDemand = (sessionId: string): boolean =>
        viewerLeaseRegistry.countActiveLeases(sessionId) > 0
        || backgroundFollowEnabledBySessionId.get(sessionId) === true;

    const reconcile = async (
        sessionId: string,
        options: Readonly<{
            activeReason: 'viewer_attached' | 'background_follow';
            propagateAcquisitionError: boolean;
        }>,
    ): Promise<Readonly<{ acquired: boolean; followLease?: ExternalSessionFollowLease }>> => {
        const state = stateFor(sessionId);
        if (disposed || !hasDemand(sessionId)) {
            state.refreshPending = false;
            state.reacquisitionCursor = null;
            const releaseResult = await releaseActual(sessionId, state, {
                status: 'disabled',
                reason: 'follow_demand_released',
            });
            if (releaseResult === 'retained') {
                return { acquired: false };
            }
            state.source?.removeRetirementListener?.();
            state.source = null;
            return { acquired: false };
        }
        const suspensionReason = state.suspensionReasons.values().next().value;
        if (suspensionReason) {
            await releaseActual(sessionId, state, {
                status: 'paused',
                reason: suspensionReason,
            });
            return { acquired: false };
        }
        const source = state.source;
        if (!source || source.resource?.retirementSignal?.aborted) {
            return { acquired: false };
        }
        if (state.actual?.key === source.key) {
            return { acquired: false };
        }
        if (state.actual) {
            state.reacquisitionCursor = null;
            const releaseResult = await releaseActual(sessionId, state, {
                status: 'paused',
                reason: 'follow_source_generation_changed',
            });
            if (releaseResult === 'retained') {
                return { acquired: false };
            }
            await publishFollowStatus(sessionId, 'reacquiring', 'follow_source_generation_changed');
        }

        if (!source.acquireFollowLease) {
            return { acquired: false };
        }

        let followLease: ExternalSessionFollowLease | null;
        state.acquisitionKey = source.key;
        try {
            followLease = state.reacquisitionCursor
                ? await source.acquireFollowLease(state.reacquisitionCursor)
                : await source.acquireFollowLease();
        } catch (error) {
            await publishFollowFailure(sessionId, 'acquire');
            if (options.propagateAcquisitionError) throw error;
            return { acquired: false };
        } finally {
            if (state.acquisitionKey === source.key) {
                state.acquisitionKey = null;
            }
        }
        if (!followLease) {
            await publishFollowFailure(sessionId, 'acquire', true);
            return { acquired: false };
        }

        if (
            disposed
            || !hasDemand(sessionId)
            || state.source?.key !== source.key
            || source.resource?.retirementSignal?.aborted
        ) {
            await followLease.release().catch(() => undefined);
            return { acquired: false };
        }

        const actual: ActualFollowRecord = {
            key: source.key,
            release: followLease.release,
            readAcceptedCursor: followLease.readAcceptedCursor ?? null,
            requestTranscriptRefresh: followLease.requestTranscriptRefresh ?? null,
            released: false,
        };
        state.actual = actual;
        state.reacquisitionCursor = null;
        state.refreshIssueCode = null;
        await publishFollowStatus(sessionId, 'active', options.activeReason);
        if (state.refreshPending) {
            await startTranscriptRefresh(sessionId, state);
        }
        return { acquired: true, followLease };
    };

    const updateSource = (
        sessionId: string,
        acquireFollowLease: FollowLeaseAcquirer | undefined,
        requestTranscriptRefresh: CursorRefreshRequester | undefined,
        resource: ExternalSessionFollowResource | undefined,
    ): void => {
        if (!acquireFollowLease && !requestTranscriptRefresh) return;
        const state = stateFor(sessionId);
        const key = resourceKey(resource);
        const previous = state.source;
        if (previous && previous.key !== key) {
            previous?.removeRetirementListener?.();
            for (const record of viewerLeasesById.values()) {
                if (record.sessionId === sessionId) record.acceptedTailCursor = null;
            }
            state.refreshPending = false;
            state.reacquisitionCursor = null;
        }
        const source: DesiredFollowSource = {
            key,
            resource: resource ?? null,
            acquireFollowLease: acquireFollowLease ?? (
                previous?.key === key ? previous.acquireFollowLease : null
            ),
            requestTranscriptRefresh: requestTranscriptRefresh ?? (
                previous?.key === key ? previous.requestTranscriptRefresh : null
            ),
            removeRetirementListener: null,
        };
        const retirementSignal = resource?.retirementSignal;
        if (retirementSignal) {
            const retire = () => {
                void runExclusive(async () => {
                    const current = statesBySessionId.get(sessionId);
                    if (!current || current.source !== source) return;
                    current.source = null;
                    current.refreshPending = false;
                    current.reacquisitionCursor = null;
                    for (const record of viewerLeasesById.values()) {
                        if (record.sessionId === sessionId) {
                            record.acceptedTailCursor = null;
                        }
                    }
                    await releaseActual(sessionId, current, {
                        status: 'paused',
                        reason: 'plugin_generation_retired',
                    }, {
                        kind: 'source_retired',
                        key: source.key,
                    });
                });
            };
            retirementSignal.addEventListener('abort', retire, { once: true });
            source.removeRetirementListener = () =>
                retirementSignal.removeEventListener('abort', retire);
        }
        previous?.removeRetirementListener?.();
        state.source = source;
    };

    const clearViewerTimer = (record: ViewerLeaseRecord | undefined): void => {
        if (record?.expiryTimer) clearTimer(record.expiryTimer);
    };

    const hasCurrentTranscriptDemand = (input: Readonly<{
        sessionId: string;
        resource: ExternalSessionFollowResource;
    }>): boolean => {
        if (disposed || !hasDemand(input.sessionId)) return false;
        const state = statesBySessionId.get(input.sessionId);
        if (!state || state.suspensionReasons.size > 0) return false;
        const expectedKey = resourceKey(input.resource);
        if (
            state.source?.key !== expectedKey
            || input.resource.retirementSignal?.aborted === true
        ) {
            return false;
        }
        const hasCursorDemand = [...viewerLeasesById.values()].some((record) =>
                record.sessionId === input.sessionId
                && record.acceptedTailCursor !== null
                && (
                    record.requestTranscriptRefresh !== null
                    || state.source?.requestTranscriptRefresh !== null
                )
            );
        const hasActualRefresh = state.actual?.key === expectedKey
            && state.actual.released === false
            && state.actual.requestTranscriptRefresh !== null;
        const isAcquiringCurrentSource = state.acquisitionKey === expectedKey;
        return hasCursorDemand || hasActualRefresh || isAcquiringCurrentSource;
    };

    const handleRefreshResult = async (input: Readonly<{
        sessionId: string;
        state: SessionFollowState;
        result: ExternalSessionFollowRefreshResult | void;
        isCurrent: () => boolean;
    }>): Promise<void> => {
        if (!input.result || !input.isCurrent()) return;
        if (
            input.result.outcome === 'source_replaced'
            || input.result.outcome === 'source_unavailable'
            || input.result.outcome === 'read_failed'
        ) {
            const issueCode = `follow_refresh_${input.result.outcome}`;
            input.state.refreshIssueCode = issueCode;
            const observedAtMs = now();
            await publishFollowStatus(
                input.sessionId,
                'error',
                issueCode,
                {
                    v: 1,
                    code: issueCode,
                    retryable: true,
                    observedAtMs,
                },
                observedAtMs,
            );
            return;
        }
        if (input.result.outcome === 'gap_or_cursor_expired') {
            const issueCode = 'follow_refresh_gap_or_cursor_expired';
            input.state.refreshIssueCode = issueCode;
            const observedAtMs = now();
            await publishFollowStatus(
                input.sessionId,
                'reacquiring',
                issueCode,
                {
                    v: 1,
                    code: issueCode,
                    retryable: true,
                    observedAtMs,
                },
                observedAtMs,
            );
            await input.result.recover();
            if (!input.isCurrent()) return;
            input.state.refreshIssueCode = null;
            const recoveredAtMs = now();
            await publishFollowStatus(
                input.sessionId,
                'active',
                'follow_refresh_resynced',
                {
                    v: 1,
                    code: issueCode,
                    retryable: false,
                    observedAtMs: recoveredAtMs,
                },
                recoveredAtMs,
            );
            return;
        }
        if (input.state.refreshIssueCode) {
            const recoveredIssueCode = input.state.refreshIssueCode;
            input.state.refreshIssueCode = null;
            const recoveredAtMs = now();
            await publishFollowStatus(
                input.sessionId,
                'active',
                'follow_refresh_recovered',
                {
                    v: 1,
                    code: recoveredIssueCode,
                    retryable: false,
                    observedAtMs: recoveredAtMs,
                },
                recoveredAtMs,
            );
        }
    };

    const publishRefreshFailure = async (
        sessionId: string,
        state: SessionFollowState,
    ): Promise<void> => {
        const issueCode = state.refreshIssueCode
            === 'follow_refresh_gap_or_cursor_expired'
            ? 'follow_refresh_resync_failed'
            : 'follow_refresh_failed';
        state.refreshIssueCode = issueCode;
        const observedAtMs = now();
        await publishFollowStatus(
            sessionId,
            'error',
            issueCode,
            {
                v: 1,
                code: issueCode,
                retryable: true,
                observedAtMs,
            },
            observedAtMs,
        );
    };

    const startTranscriptRefresh = (
        sessionId: string,
        state: SessionFollowState,
    ): Promise<void> => {
        let pump: Promise<void>;
        let refreshSource: DesiredFollowSource | null = null;
        pump = (async () => {
            do {
                state.refreshPending = false;
                refreshSource = state.source;
                const refreshActual = state.actual;
                const refreshAuthorityEpoch = state.authorityEpoch;
                const viewerRefreshes = [...viewerLeasesById.values()]
                    .filter((record) =>
                        record.sessionId === sessionId
                        && record.acceptedTailCursor !== null
                        && record.requestTranscriptRefresh !== null,
                    );
                if (viewerRefreshes.length > 0) {
                    const refreshGroups: Array<Readonly<{
                        cursor: string;
                        representative: ViewerLeaseRecord;
                        delivery: ViewerLeaseRecord['refreshDelivery'];
                    }>> = [];
                    const ordinaryRefreshByCursor = new Map<
                        string,
                        (typeof refreshGroups)[number]
                    >();
                    for (const record of viewerRefreshes) {
                        const cursor = record.acceptedTailCursor!;
                        if (record.refreshDelivery === 'scoped_listener') {
                            refreshGroups.push({
                                cursor,
                                representative: record,
                                delivery: record.refreshDelivery,
                            });
                            continue;
                        }
                        if (ordinaryRefreshByCursor.has(cursor)) continue;
                        const group = {
                            cursor,
                            representative: record,
                            delivery: record.refreshDelivery,
                        } as const;
                        ordinaryRefreshByCursor.set(cursor, group);
                        refreshGroups.push(group);
                    }
                    await Promise.all(refreshGroups.map(async (group) => {
                        const record = group.representative;
                        const isCurrent = () =>
                            state.source === refreshSource
                            && state.authorityEpoch === refreshAuthorityEpoch
                            && (
                                refreshActual === null
                                || (
                                    state.actual === refreshActual
                                    && !refreshActual.released
                                )
                            )
                            && state.suspensionReasons.size === 0
                            && (
                                group.delivery === 'session_invalidation'
                                    ? [...viewerLeasesById.values()].some(
                                        (currentRecord) =>
                                            currentRecord.sessionId === sessionId
                                            && currentRecord.refreshDelivery
                                                === 'session_invalidation'
                                            && currentRecord.acceptedTailCursor
                                                === group.cursor
                                            && currentRecord.requestTranscriptRefresh
                                                !== null,
                                    )
                                    : viewerLeasesById.get(
                                        viewerLeaseKey(record.sessionId, record.leaseId),
                                    ) === record
                            );
                        try {
                            const result = await record.requestTranscriptRefresh!(
                                group.cursor,
                                isCurrent,
                            );
                            await handleRefreshResult({
                                sessionId,
                                state,
                                result,
                                isCurrent,
                            });
                        } catch {
                            if (isCurrent()) {
                                await publishRefreshFailure(sessionId, state);
                            }
                        }
                    }));
                } else {
                    const actual = state.actual;
                    if (!actual?.requestTranscriptRefresh) continue;
                    try {
                        const result = await actual.requestTranscriptRefresh();
                        if (
                            state.actual !== actual
                            || actual.released
                            || state.source !== refreshSource
                        ) {
                            continue;
                        }
                        await handleRefreshResult({
                            sessionId,
                            state,
                            result,
                            isCurrent: () =>
                                state.actual === actual
                                && !actual.released
                                && state.source === refreshSource,
                        });
                    } catch {
                        if (
                            state.actual !== actual
                            || actual.released
                            || state.source !== refreshSource
                        ) {
                            continue;
                        }
                        await publishRefreshFailure(sessionId, state);
                    }
                }
            } while (
                state.refreshPending
                && !disposed
                && hasDemand(sessionId)
                && state.suspensionReasons.size === 0
                && state.source === refreshSource
                && refreshSource?.resource?.retirementSignal?.aborted !== true
            );
        })().finally(() => {
            if (state.refreshInFlight !== pump) {
                return;
            }
            state.refreshInFlight = null;
            const pendingResource = state.source?.resource;
            if (
                !state.refreshPending
                || !pendingResource
            ) {
                state.refreshPending = false;
                return;
            }
            if (state.suspensionReasons.size > 0) {
                return;
            }
            if (!hasCurrentTranscriptDemand({ sessionId, resource: pendingResource })) {
                state.refreshPending = false;
                return;
            }
            return startTranscriptRefresh(sessionId, state);
        });
        state.refreshInFlight = pump;
        return pump;
    };

    const scheduleExpiry = (
        leaseId: string,
        sessionId: string,
        expiresAtMs: number,
    ): void => {
        const recordKey = viewerLeaseKey(sessionId, leaseId);
        const record = viewerLeasesById.get(recordKey);
        if (!record || record.sessionId !== sessionId) return;
        clearViewerTimer(record);
        record.expiryTimer = setTimer(() => {
            void runExclusive(async () => {
                const current = viewerLeasesById.get(recordKey);
                if (current !== record) return;
                viewerLeaseRegistry.detach({ sessionId, leaseId });
                viewerLeasesById.delete(recordKey);
                await reconcile(sessionId, {
                    activeReason: 'background_follow',
                    propagateAcquisitionError: false,
                });
            });
        }, Math.max(0, expiresAtMs - now()));
    };

    const releaseSessionNow = async (
        sessionId: string,
        reason: 'archived' | 'connected_account_invalidated',
    ): Promise<Readonly<{
        releasedAttachedLeases: number;
        releasedBackgroundLease: boolean;
    }>> => {
        const attachedLeaseKeys = [...viewerLeasesById.entries()]
            .filter(([, record]) => record.sessionId === sessionId)
            .map(([key]) => key);
        const hadBackgroundPolicy =
            backgroundFollowEnabledBySessionId.get(sessionId) === true;
        for (const recordKey of attachedLeaseKeys) {
            const lease = viewerLeasesById.get(recordKey);
            if (!lease) continue;
            viewerLeaseRegistry.detach({
                sessionId,
                leaseId: lease.leaseId,
            });
            clearViewerTimer(lease);
            viewerLeasesById.delete(recordKey);
        }
        backgroundFollowEnabledBySessionId.delete(sessionId);
        const state = statesBySessionId.get(sessionId);
        const releaseResult = state
            ? await releaseActual(sessionId, state, {
                status: 'paused',
                reason,
            }, {
                kind: 'manager_terminal',
            })
            : 'none';
        state?.source?.removeRetirementListener?.();
        statesBySessionId.delete(sessionId);
        return {
            releasedAttachedLeases: attachedLeaseKeys.length,
            releasedBackgroundLease:
                releaseResult === 'released'
                && hadBackgroundPolicy
                && attachedLeaseKeys.length === 0,
        };
    };

    return {
        async attach(input: Readonly<{
            sessionId: string;
            leaseId?: string | null;
            ttlMs: number;
            acceptedTailCursor?: string | null;
            resource?: ExternalSessionFollowResource;
            acquireFollowLease?: FollowLeaseAcquirer;
            requestTranscriptRefresh?: CursorRefreshRequester;
        }>) {
            return await runExclusive(async () => {
                if (disposed) throw new Error('External Session follow lease manager is disposed');
                const attached = viewerLeaseRegistry.attach({
                    sessionId: input.sessionId,
                    leaseId: input.leaseId,
                    ttlMs: input.ttlMs,
                });
                const recordKey = viewerLeaseKey(input.sessionId, attached.leaseId);
                const existing = viewerLeasesById.get(recordKey);
                clearViewerTimer(existing);
                updateSource(
                    input.sessionId,
                    input.acquireFollowLease,
                    input.requestTranscriptRefresh,
                    input.resource,
                );
                viewerLeasesById.set(recordKey, {
                    sessionId: input.sessionId,
                    leaseId: attached.leaseId,
                    acceptedTailCursor: input.requestTranscriptRefresh
                        && input.resource?.retirementSignal?.aborted !== true
                        && typeof input.acceptedTailCursor === 'string'
                        && input.acceptedTailCursor.trim().length > 0
                        ? input.acceptedTailCursor.trim()
                        : null,
                    requestTranscriptRefresh: input.requestTranscriptRefresh ?? null,
                    refreshDelivery: 'session_invalidation',
                    expiryTimer: null,
                });
                try {
                    await reconcile(input.sessionId, {
                        activeReason: 'viewer_attached',
                        propagateAcquisitionError: true,
                    });
                } catch (error) {
                    viewerLeaseRegistry.detach({
                        sessionId: input.sessionId,
                        leaseId: attached.leaseId,
                    });
                    viewerLeasesById.delete(recordKey);
                    throw error;
                }
                scheduleExpiry(
                    attached.leaseId,
                    input.sessionId,
                    attached.expiresAtMs,
                );
                const acceptedTailCursor =
                    viewerLeasesById.get(recordKey)?.acceptedTailCursor ?? null;
                return {
                    ...attached,
                    ...(acceptedTailCursor ? { acceptedTailCursor } : {}),
                };
            });
        },

        async attachScoped(input: Readonly<{
            sessionId: string;
            acceptedTailCursor: string;
            resource: ExternalSessionFollowResource;
            acquireFollowLease: FollowLeaseAcquirer;
            requestTranscriptRefresh: CursorRefreshRequester;
        }>) {
            const attached = await runExclusive(async () => {
                if (disposed) {
                    throw new Error('External Session follow lease manager is disposed');
                }
                const viewer = viewerLeaseRegistry.attach({
                    sessionId: input.sessionId,
                    ttlMs: Number.MAX_SAFE_INTEGER - now(),
                });
                const recordKey = viewerLeaseKey(input.sessionId, viewer.leaseId);
                updateSource(
                    input.sessionId,
                    input.acquireFollowLease,
                    undefined,
                    input.resource,
                );
                viewerLeasesById.set(recordKey, {
                    sessionId: input.sessionId,
                    leaseId: viewer.leaseId,
                    acceptedTailCursor: input.acceptedTailCursor,
                    requestTranscriptRefresh: input.requestTranscriptRefresh,
                    refreshDelivery: 'scoped_listener',
                    expiryTimer: null,
                });
                try {
                    await reconcile(input.sessionId, {
                        activeReason: 'viewer_attached',
                        propagateAcquisitionError: true,
                    });
                } catch (error) {
                    viewerLeaseRegistry.detach({
                        sessionId: input.sessionId,
                        leaseId: viewer.leaseId,
                    });
                    viewerLeasesById.delete(recordKey);
                    throw error;
                }
                return viewer;
            });
            let released = false;
            return Object.freeze({
                leaseId: attached.leaseId,
                release: async () => {
                    if (released) return;
                    released = true;
                    await runExclusive(async () => {
                        viewerLeaseRegistry.detach({
                            sessionId: input.sessionId,
                            leaseId: attached.leaseId,
                        });
                        viewerLeasesById.delete(
                            viewerLeaseKey(input.sessionId, attached.leaseId),
                        );
                        await reconcile(input.sessionId, {
                            activeReason: 'background_follow',
                            propagateAcquisitionError: false,
                        });
                    });
                },
            });
        },

        async detach(input: Readonly<{ sessionId: string; leaseId: string }>) {
            return await runExclusive(async () => {
                const detached = viewerLeaseRegistry.detach(input);
                if (!detached.detached) return detached;
                const recordKey = viewerLeaseKey(input.sessionId, input.leaseId);
                const record = viewerLeasesById.get(recordKey);
                clearViewerTimer(record);
                viewerLeasesById.delete(recordKey);
                await reconcile(input.sessionId, {
                    activeReason: 'background_follow',
                    propagateAcquisitionError: false,
                });
                return detached;
            });
        },

        async setBackgroundFollowEnabled(input: Readonly<{
            sessionId: string;
            enabled: boolean;
            resource?: ExternalSessionFollowResource;
            acquireFollowLease?: FollowLeaseAcquirer;
        }>) {
            return await runExclusive(async () => {
                if (disposed) throw new Error('External Session follow lease manager is disposed');
                backgroundFollowEnabledBySessionId.set(input.sessionId, input.enabled);
                updateSource(
                    input.sessionId,
                    input.acquireFollowLease,
                    undefined,
                    input.resource,
                );
                const result = await reconcile(input.sessionId, {
                    activeReason: viewerLeaseRegistry.countActiveLeases(input.sessionId) > 0
                        ? 'viewer_attached'
                        : 'background_follow',
                    propagateAcquisitionError: input.enabled,
                });
                return result.acquired && result.followLease
                    ? {
                        enabled: input.enabled,
                        leaseAcquired: true,
                        followLease: result.followLease,
                    } as const
                    : { enabled: input.enabled, leaseAcquired: false } as const;
            });
        },

        async archiveSession(input: Readonly<{
            sessionId: string;
            preserveBackgroundFollow?: boolean;
        }>) {
            return await runExclusive(async () => {
                if (disposed) {
                    throw new Error('External Session follow lease manager is disposed');
                }
                if (input.preserveBackgroundFollow === true) {
                    backgroundFollowEnabledBySessionId.set(
                        input.sessionId,
                        true,
                    );
                }
                const attachedLeaseKeys = [...viewerLeasesById.entries()]
                    .filter(([, record]) => record.sessionId === input.sessionId)
                    .map(([key]) => key);
                for (const recordKey of attachedLeaseKeys) {
                    const record = viewerLeasesById.get(recordKey);
                    if (!record) continue;
                    viewerLeaseRegistry.detach({
                        sessionId: input.sessionId,
                        leaseId: record.leaseId,
                    });
                    clearViewerTimer(record);
                    viewerLeasesById.delete(recordKey);
                }

                const backgroundFollowEnabled =
                    backgroundFollowEnabledBySessionId.get(input.sessionId)
                    === true;
                const existingState = statesBySessionId.get(input.sessionId);
                if (!existingState && !backgroundFollowEnabled) {
                    return {
                        releasedAttachedLeases: attachedLeaseKeys.length,
                        releaseSettled: true,
                    } as const;
                }
                const state = existingState ?? stateFor(input.sessionId);
                const reacquisitionCursor =
                    backgroundFollowEnabled
                        ? state.actual?.readAcceptedCursor?.()?.trim() || null
                        : null;
                state.authorityEpoch += 1;
                state.suspensionReasons.add('session_archived');
                const releaseResult = await releaseActual(
                    input.sessionId,
                    state,
                    {
                        status: 'paused',
                        reason: 'session_archived',
                    },
                );
                if (backgroundFollowEnabled && reacquisitionCursor !== null) {
                    state.reacquisitionCursor = reacquisitionCursor;
                    state.refreshPending = true;
                }
                if (releaseResult === 'none' && backgroundFollowEnabled) {
                    await publishFollowStatus(
                        input.sessionId,
                        'paused',
                        'session_archived',
                    );
                }
                return {
                    releasedAttachedLeases: attachedLeaseKeys.length,
                    releaseSettled: releaseResult !== 'retained',
                } as const;
            });
        },

        async suspendSession(input: Readonly<{
            sessionId: string;
            reason: string;
        }>) {
            return await runExclusive(async () => {
                const state = stateFor(input.sessionId);
                const hasViewerCatchUp = [...viewerLeasesById.values()].some((record) =>
                    record.sessionId === input.sessionId
                    && record.acceptedTailCursor !== null
                    && (
                        record.requestTranscriptRefresh !== null
                        || state.source?.requestTranscriptRefresh !== null
                    )
                );
                const reacquisitionCursor = hasViewerCatchUp
                    ? null
                    : state.actual?.readAcceptedCursor?.()?.trim() || null;
                const shouldCatchUpAfterResume = hasDemand(input.sessionId)
                    && (
                        reacquisitionCursor !== null
                        || hasViewerCatchUp
                    );
                state.authorityEpoch += 1;
                state.suspensionReasons.add(input.reason);
                const releaseResult = await releaseActual(input.sessionId, state, {
                    status: 'paused',
                    reason: input.reason,
                });
                if (shouldCatchUpAfterResume) {
                    state.reacquisitionCursor = reacquisitionCursor;
                    state.refreshPending = true;
                }
                return releaseResult === 'released' || releaseResult === 'fenced';
            });
        },

        isSessionSuspended(input: Readonly<{
            sessionId: string;
            reason?: string;
        }>): boolean {
            const suspensionReasons =
                statesBySessionId.get(input.sessionId)?.suspensionReasons;
            if (!suspensionReasons || suspensionReasons.size === 0) return false;
            return input.reason === undefined
                || suspensionReasons.has(input.reason);
        },

        async resumeSession(input: Readonly<{
            sessionId: string;
            reason: string;
        }>) {
            return await runExclusive(async () => {
                if (disposed) {
                    throw new Error('External Session follow lease manager is disposed');
                }
                const state = statesBySessionId.get(input.sessionId);
                if (!state || !state.suspensionReasons.delete(input.reason)) {
                    return { resumed: false, leaseAcquired: false } as const;
                }
                if (state.suspensionReasons.size > 0) {
                    return { resumed: true, leaseAcquired: false } as const;
                }
                if (hasDemand(input.sessionId)) {
                    await publishFollowStatus(
                        input.sessionId,
                        'reacquiring',
                        'follow_suspension_released',
                    );
                }
                const result = await reconcile(input.sessionId, {
                    activeReason: viewerLeaseRegistry.countActiveLeases(input.sessionId) > 0
                        ? 'viewer_attached'
                        : 'background_follow',
                    propagateAcquisitionError: false,
                });
                return {
                    resumed: true,
                    leaseAcquired: result.acquired,
                } as const;
            });
        },

        async releaseSession(input: Readonly<{ sessionId: string }>) {
            return await runExclusive(async () =>
                await releaseSessionNow(input.sessionId, 'archived'));
        },

        async releaseSessionsForCredentialInvalidation() {
            return await runExclusive(async () => {
                const sessionIds = new Set([
                    ...statesBySessionId.keys(),
                    ...backgroundFollowEnabledBySessionId.keys(),
                    ...[...viewerLeasesById.values()].map((record) => record.sessionId),
                ]);
                for (const sessionId of sessionIds) {
                    await releaseSessionNow(
                        sessionId,
                        'connected_account_invalidated',
                    );
                }
                return { releasedSessions: sessionIds.size } as const;
            });
        },

        async dispose() {
            return await runExclusive(async () => {
                if (disposed) return;
                disposed = true;
                for (const record of viewerLeasesById.values()) clearViewerTimer(record);
                viewerLeasesById.clear();
                backgroundFollowEnabledBySessionId.clear();
                for (const [sessionId, state] of statesBySessionId) {
                    state.source?.removeRetirementListener?.();
                    await releaseActual(sessionId, state, {
                        status: 'paused',
                        reason: 'daemon_disconnected',
                    }, {
                        kind: 'manager_terminal',
                    });
                }
                statesBySessionId.clear();
            });
        },

        countActiveLeases(sessionId: string): number {
            return viewerLeaseRegistry.countActiveLeases(sessionId);
        },

        isBackgroundFollowEnabled(sessionId: string): boolean {
            return backgroundFollowEnabledBySessionId.get(sessionId) ?? false;
        },

        hasBackgroundFollowLease(sessionId: string): boolean {
            return backgroundFollowEnabledBySessionId.get(sessionId) === true
                && Boolean(statesBySessionId.get(sessionId)?.actual);
        },

        hasTranscriptDemand(input: Readonly<{
            sessionId: string;
            resource: ExternalSessionFollowResource;
        }>): boolean {
            return hasCurrentTranscriptDemand(input);
        },

        async requestTranscriptRefresh(input: Readonly<{
            sessionId: string;
            resource: ExternalSessionFollowResource;
        }>) {
            if (!hasDemand(input.sessionId)) {
                return { requested: false, reason: 'not-demanded' } as const;
            }
            const state = statesBySessionId.get(input.sessionId);
            const expectedKey = resourceKey(input.resource);
            if (!state?.source) {
                return { requested: false, reason: 'not-demanded' } as const;
            }
            if (
                state.source.key !== expectedKey
                || (state.actual && state.actual.key !== expectedKey)
            ) {
                return { requested: false, reason: 'stale-source' } as const;
            }
            if (!hasCurrentTranscriptDemand(input)) {
                return { requested: false, reason: 'not-demanded' } as const;
            }
            const hasCursorRefresh = [...viewerLeasesById.values()].some((record) =>
                    record.sessionId === input.sessionId
                    && record.acceptedTailCursor !== null
                    && (
                        record.requestTranscriptRefresh !== null
                        || state.source?.requestTranscriptRefresh !== null
                    )
                );
            if (
                !hasCursorRefresh
                && !state.actual?.requestTranscriptRefresh
                && state.acquisitionKey !== expectedKey
            ) {
                return { requested: false, reason: 'unavailable' } as const;
            }
            if (
                !hasCursorRefresh
                && !state.actual?.requestTranscriptRefresh
                && state.acquisitionKey === expectedKey
            ) {
                state.refreshPending = true;
                return { requested: true, coalesced: true } as const;
            }
            if (state.refreshInFlight) {
                state.refreshPending = true;
                return { requested: true, coalesced: true } as const;
            }
            await startTranscriptRefresh(input.sessionId, state);
            return { requested: true, coalesced: false } as const;
        },
    };
}
