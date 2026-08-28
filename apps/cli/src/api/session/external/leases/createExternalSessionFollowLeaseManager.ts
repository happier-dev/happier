import { randomUUID } from 'node:crypto';

import type {
    ExternalSessionFollowIssueV1,
    ExternalSessionFollowStatusV1,
} from '@happier-dev/protocol';

import { logger } from '@/utils/logger';
import {
    ExternalSessionFollowFailureError,
} from '@/session/external/externalSessionFollowFailure';


const MAX_ACTIVE_VIEWER_LEASES_PER_SESSION = 64;

export class ExternalSessionViewerLeaseCapacityExceededError extends Error {
    readonly name = 'ExternalSessionViewerLeaseCapacityExceededError';

    constructor() {
        super('External Session viewer lease capacity exceeded');
    }
}

export type ExternalSessionFollowRefreshResult =
    | Readonly<{ outcome: 'already_current' | 'advanced' }>
    | Readonly<{
        outcome: 'gap_or_cursor_expired';
        /**
         * Bounded authoritative resync. It resolves `{ outcome: 'resync_required' }`
         * when the gapped interval cannot be FULLY reconciled from the one bounded
         * read it is allowed — the accepted cursor is then retained untouched and the
         * caller routes the existing `resync_required` state. Resolving `void` means
         * the recovery committed a proven-continuous accepted cursor.
         */
        recover: () => Promise<Readonly<{ outcome: 'resync_required' }> | void>;
    }>
    | Readonly<{
        outcome: 'source_replaced' | 'source_unavailable' | 'read_failed';
    }>
    | Readonly<{ outcome: 'resync_required' }>;

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
    expiresAtMs: number;
    acceptedTailCursor: string | null;
    requestTranscriptRefresh: CursorRefreshRequester | null;
    onSourceReplaced: (() => Promise<void>) | null;
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
    resource: ExternalSessionFollowResource | null;
    release: () => Promise<void>;
    readAcceptedCursor: (() => string | null) | null;
    requestTranscriptRefresh:
        (() => Promise<ExternalSessionFollowRefreshResult | void>) | null;
    released: boolean;
};

type ActualReleaseResult = 'none' | 'released' | 'retained' | 'fenced';
type RefreshStatusPublicationMode = 'inline' | 'session_exclusive';
const TRANSCRIPT_REFRESH_RETRY_DELAYS_MS = [250, 1_000, 4_000] as const;

type PendingFollowStatusPublication = Readonly<{
    resource: ExternalSessionFollowResource | null;
    followStatusV1: ExternalSessionFollowStatusV1;
    lastFollowIssueV1?: ExternalSessionFollowIssueV1;
}>;

type SessionFollowState = {
    source: DesiredFollowSource | null;
    actual: ActualFollowRecord | null;
    acquisitionKey: string | null;
    authorityEpoch: number;
    suspensionReasons: Set<string>;
    refreshIssueCode: string | null;
    refreshInFlight: Promise<void> | null;
    refreshPending: boolean;
    refreshRetryAttempt: number;
    refreshRetryTimer: ReturnType<typeof setTimeout> | null;
    reacquisitionCursor: string | null;
    pendingFollowStatus: PendingFollowStatusPublication | null;
};

type ExternalSessionFollowLeaseManagerParams = Readonly<{
    now?: () => number;
    randomId?: () => string;
    setTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
    writeFollowStatus?: (input: Readonly<{
        sessionId: string;
        expectedLinkGeneration?: string;
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
    const randomId = params?.randomId ?? randomUUID;
    /**
     * The one owner of viewer-lease state, keyed by Session and lease identity. It
     * holds the lease's expiry alongside its cursor/refresh custody, so demand,
     * capacity, renewal and expiry are all decided from the same record.
     */
    const viewerLeasesById = new Map<string, ViewerLeaseRecord>();
    const backgroundFollowEnabledBySessionId = new Map<string, boolean>();
    const statesBySessionId = new Map<string, SessionFollowState>();
    let disposed = false;
    let barrierOperations = Promise.resolve();
    const operationsBySessionId = new Map<string, Promise<void>>();

    const runSessionExclusive = <T>(
        sessionId: string,
        operation: () => Promise<T>,
    ): Promise<T> => {
        const priorSessionOperation = operationsBySessionId.get(sessionId)
            ?? Promise.resolve();
        const result = Promise.all([
            barrierOperations,
            priorSessionOperation,
        ]).then(() => operation());
        const settled = result.then(() => undefined, () => undefined);
        operationsBySessionId.set(sessionId, settled);
        void settled.then(() => {
            if (operationsBySessionId.get(sessionId) === settled) {
                operationsBySessionId.delete(sessionId);
            }
        });
        return result;
    };

    const runBarrierExclusive = <T>(operation: () => Promise<T>): Promise<T> => {
        const result = Promise.all([
            barrierOperations,
            ...operationsBySessionId.values(),
        ]).then(() => operation());
        barrierOperations = result.then(() => undefined, () => undefined);
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
            refreshRetryAttempt: 0,
            refreshRetryTimer: null,
            reacquisitionCursor: null,
            pendingFollowStatus: null,
        };
        statesBySessionId.set(sessionId, created);
        return created;
    };

    const retryPendingFollowStatus = async (
        sessionId: string,
        state: SessionFollowState,
    ): Promise<void> => {
        const pending = state.pendingFollowStatus;
        if (!pending) return;
        if (!params?.writeFollowStatus) {
            if (state.pendingFollowStatus === pending) {
                state.pendingFollowStatus = null;
            }
            return;
        }
        try {
            await params.writeFollowStatus({
                sessionId,
                ...(pending.resource
                    ? { expectedLinkGeneration: pending.resource.linkGeneration }
                    : {}),
                followStatusV1: pending.followStatusV1,
                ...(pending.lastFollowIssueV1 === undefined
                    ? {}
                    : { lastFollowIssueV1: pending.lastFollowIssueV1 }),
            });
            if (state.pendingFollowStatus === pending) {
                state.pendingFollowStatus = null;
            }
        } catch {
            logger.debug('[externalSessions.follow] Follow-status metadata write failed (non-fatal)', {
                sessionId,
                status: pending.followStatusV1.status,
                reason: pending.followStatusV1.reason,
            });
        }
    };

    const publishFollowStatus = async (
        sessionId: string,
        resource: ExternalSessionFollowResource | null,
        status: ExternalSessionFollowStatusV1['status'],
        reason: string,
        lastFollowIssueV1?: ExternalSessionFollowIssueV1,
        updatedAtMs = now(),
    ): Promise<void> => {
        const state = stateFor(sessionId);
        state.pendingFollowStatus = {
            resource,
            followStatusV1: { v: 1, status, reason, updatedAtMs },
            ...(lastFollowIssueV1 === undefined ? {} : { lastFollowIssueV1 }),
        };
        await retryPendingFollowStatus(sessionId, state);
    };

    const publishFollowFailure = async (
        sessionId: string,
        resource: ExternalSessionFollowResource | null,
        operation: 'acquire' | 'release',
        unavailable = false,
    ): Promise<void> => {
        const observedAtMs = now();
        const reason = unavailable ? 'lease_unavailable' : `lease_${operation}_failed`;
        await publishFollowStatus(sessionId, resource, 'error', reason, {
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
        clearRefreshRetry(state);
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
            await publishFollowFailure(sessionId, actual.resource, 'release');
            return fenced ? 'fenced' : 'retained';
        }
        if (state.actual === actual) state.actual = null;
        await publishFollowStatus(
            sessionId,
            actual.resource,
            transition.status,
            transition.reason,
        );
        return 'released';
    };

    const hasDemand = (sessionId: string): boolean =>
        countActiveViewerLeases(sessionId) > 0
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
            clearRefreshRetry(state);
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
            clearRefreshRetry(state);
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
            await publishFollowStatus(
                sessionId,
                source.resource,
                'reacquiring',
                'follow_source_generation_changed',
            );
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
            await publishFollowFailure(sessionId, source.resource, 'acquire');
            if (options.propagateAcquisitionError) throw error;
            return { acquired: false };
        } finally {
            if (state.acquisitionKey === source.key) {
                state.acquisitionKey = null;
            }
        }
        if (!followLease) {
            await publishFollowFailure(sessionId, source.resource, 'acquire', true);
            return { acquired: false };
        }

        if (
            disposed
            || !hasDemand(sessionId)
            || state.source?.key !== source.key
            || source.resource?.retirementSignal?.aborted
        ) {
            const actual: ActualFollowRecord = {
                key: source.key,
                resource: source.resource,
                release: followLease.release,
                readAcceptedCursor: followLease.readAcceptedCursor ?? null,
                requestTranscriptRefresh: followLease.requestTranscriptRefresh ?? null,
                released: false,
            };
            // Acquisition completed after its owner had already transitioned
            // away. Put this exact lease under the existing actual-lease owner
            // so the queued terminal transition retains and retries it rather
            // than losing a failed close acknowledgement.
            state.actual = actual;
            await releaseActual(sessionId, state, {
                status: disposed
                    ? 'paused'
                    : !hasDemand(sessionId)
                        ? 'disabled'
                        : 'paused',
                reason: disposed
                    ? 'daemon_disconnected'
                    : !hasDemand(sessionId)
                        ? 'follow_demand_released'
                        : source.resource?.retirementSignal?.aborted
                            ? 'plugin_generation_retired'
                            : 'follow_source_generation_changed',
            });
            return { acquired: false };
        }

        const actual: ActualFollowRecord = {
            key: source.key,
            resource: source.resource,
            release: followLease.release,
            readAcceptedCursor: followLease.readAcceptedCursor ?? null,
            requestTranscriptRefresh: followLease.requestTranscriptRefresh ?? null,
            released: false,
        };
        state.actual = actual;
        state.reacquisitionCursor = null;
        state.refreshIssueCode = null;
        await publishFollowStatus(
            sessionId,
            actual.resource,
            'active',
            options.activeReason,
        );
        if (state.refreshPending) {
            await startTranscriptRefresh(sessionId, state, 'inline');
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
            clearRefreshRetry(state);
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
                void runSessionExclusive(sessionId, async () => {
                    const current = statesBySessionId.get(sessionId);
                    if (!current || current.source !== source) return;
                    current.source = null;
                    current.refreshPending = false;
                    clearRefreshRetry(current);
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
                    await retryPendingFollowStatus(sessionId, current);
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

    const forgetViewerLease = (recordKey: string): void => {
        const record = viewerLeasesById.get(recordKey);
        if (!record) return;
        clearViewerTimer(record);
        viewerLeasesById.delete(recordKey);
    };

    const pruneExpiredViewerLeases = (sessionId: string): void => {
        const cutoff = now();
        for (const [recordKey, record] of viewerLeasesById) {
            if (record.sessionId !== sessionId) continue;
            if (record.expiresAtMs > cutoff) continue;
            forgetViewerLease(recordKey);
        }
    };

    const countActiveViewerLeases = (sessionId: string): number => {
        pruneExpiredViewerLeases(sessionId);
        let active = 0;
        for (const record of viewerLeasesById.values()) {
            if (record.sessionId === sessionId) active += 1;
        }
        return active;
    };

    const detachViewerLease = (input: Readonly<{
        sessionId: string;
        leaseId: string;
    }>): Readonly<{ detached: boolean }> => {
        pruneExpiredViewerLeases(input.sessionId);
        const recordKey = viewerLeaseKey(input.sessionId, input.leaseId);
        const detached = viewerLeasesById.has(recordKey);
        forgetViewerLease(recordKey);
        return { detached } as const;
    };

    /**
     * Resolves the identity and expiry a viewer lease is admitted with. The caller
     * writes the record itself, because attaching also settles the source and the
     * cursor custody that belong to the same record.
     */
    const admitViewerLease = (input: Readonly<{
        sessionId: string;
        leaseId?: string | null;
        ttlMs: number;
    }>): Readonly<{
        leaseId: string;
        expiresAtMs: number;
        renewed: boolean;
    }> => {
        const active = countActiveViewerLeases(input.sessionId);
        const requestedLeaseId =
            typeof input.leaseId === 'string' && input.leaseId.trim().length > 0
                ? input.leaseId.trim()
                : null;
        const existing = requestedLeaseId
            ? viewerLeasesById.get(
                viewerLeaseKey(input.sessionId, requestedLeaseId),
            ) ?? null
            : null;
        if (!existing && active >= MAX_ACTIVE_VIEWER_LEASES_PER_SESSION) {
            throw new ExternalSessionViewerLeaseCapacityExceededError();
        }
        return {
            leaseId: existing?.leaseId ?? requestedLeaseId ?? randomId(),
            expiresAtMs: now() + input.ttlMs,
            renewed: existing !== null,
        } as const;
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

    const clearRefreshRetry = (
        state: SessionFollowState,
        options: Readonly<{ resetAttempt?: boolean }> = {},
    ): void => {
        if (state.refreshRetryTimer !== null) {
            clearTimer(state.refreshRetryTimer);
            state.refreshRetryTimer = null;
        }
        if (options.resetAttempt !== false) {
            state.refreshRetryAttempt = 0;
        }
    };

    const scheduleRefreshRetry = (input: Readonly<{
        sessionId: string;
        state: SessionFollowState;
        isCurrent: () => boolean;
    }>): void => {
        const source = input.state.source;
        const resource = source?.resource;
        if (
            input.state.refreshRetryTimer !== null
            || !source
            || !resource
            || !input.isCurrent()
            || !hasCurrentTranscriptDemand({
                sessionId: input.sessionId,
                resource,
            })
        ) {
            return;
        }
        const delayMs = TRANSCRIPT_REFRESH_RETRY_DELAYS_MS[
            input.state.refreshRetryAttempt
        ];
        if (delayMs === undefined) return;
        input.state.refreshRetryAttempt += 1;
        const expectedAuthorityEpoch = input.state.authorityEpoch;
        let retryTimer!: ReturnType<typeof setTimeout>;
        retryTimer = setTimer(() => {
            if (input.state.refreshRetryTimer !== retryTimer) return;
            input.state.refreshRetryTimer = null;
            void runSessionExclusive(input.sessionId, async () => {
                if (
                    disposed
                    || input.state.source !== source
                    || input.state.authorityEpoch !== expectedAuthorityEpoch
                    || !input.isCurrent()
                    || !hasCurrentTranscriptDemand({
                        sessionId: input.sessionId,
                        resource,
                    })
                ) {
                    return;
                }
                input.state.refreshPending = true;
                if (input.state.refreshInFlight) return;
                await startTranscriptRefresh(
                    input.sessionId,
                    input.state,
                    'inline',
                );
            }).catch(() => undefined);
        }, delayMs);
        input.state.refreshRetryTimer = retryTimer;
        retryTimer.unref?.();
    };

    const settleScopedSourceReplacement = (
        sessionId: string,
    ): Array<() => Promise<void>> => {
        const settlements: Array<() => Promise<void>> = [];
        for (const [recordKey, record] of viewerLeasesById) {
            if (
                record.sessionId !== sessionId
                || record.refreshDelivery !== 'scoped_listener'
            ) {
                continue;
            }
            forgetViewerLease(recordKey);
            if (record.onSourceReplaced) {
                settlements.push(record.onSourceReplaced);
            }
        }
        return settlements;
    };

    const handleRefreshResult = async (input: Readonly<{
        sessionId: string;
        state: SessionFollowState;
        result: ExternalSessionFollowRefreshResult | void;
        isCurrent: () => boolean;
        statusPublicationMode: RefreshStatusPublicationMode;
    }>): Promise<void> => {
        const refreshResult = input.result;
        if (!refreshResult || !input.isCurrent()) return;
        const applyStatusMutation = async (
            operation: () => Promise<void>,
        ): Promise<void> => input.statusPublicationMode === 'inline'
            ? await operation()
            : await runSessionExclusive(input.sessionId, operation);
        if (
            refreshResult.outcome === 'source_replaced'
            || refreshResult.outcome === 'resync_required'
        ) {
            const issueCode = `follow_refresh_${refreshResult.outcome}`;
            let sourceReplacementSettlements: Array<() => Promise<void>> = [];
            await applyStatusMutation(async () => {
                if (!input.isCurrent()) return;
                const resource =
                    input.state.actual?.resource
                    ?? input.state.source?.resource
                    ?? null;
                input.state.authorityEpoch += 1;
                input.state.refreshIssueCode = issueCode;
                input.state.refreshPending = false;
                clearRefreshRetry(input.state);
                input.state.reacquisitionCursor = null;
                input.state.source?.removeRetirementListener?.();
                input.state.source = null;
                for (const record of viewerLeasesById.values()) {
                    if (record.sessionId === input.sessionId) {
                        record.acceptedTailCursor = null;
                    }
                }
                await releaseActual(
                    input.sessionId,
                    input.state,
                    {
                        status: 'paused',
                        reason: issueCode,
                    },
                    { kind: 'manager_terminal' },
                );
                const observedAtMs = now();
                await publishFollowStatus(
                    input.sessionId,
                    resource,
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
                if (refreshResult.outcome === 'source_replaced') {
                    sourceReplacementSettlements = settleScopedSourceReplacement(
                        input.sessionId,
                    );
                }
            });
            await Promise.allSettled(sourceReplacementSettlements.map(async (settle) =>
                await settle()));
            return;
        }
        if (
            refreshResult.outcome === 'source_unavailable'
            || refreshResult.outcome === 'read_failed'
        ) {
            const issueCode = `follow_refresh_${refreshResult.outcome}`;
            let retryableFailure = false;
            await applyStatusMutation(async () => {
                if (!input.isCurrent()) return;
                input.state.refreshIssueCode = issueCode;
                const observedAtMs = now();
                await publishFollowStatus(
                    input.sessionId,
                    input.state.actual?.resource ?? input.state.source?.resource ?? null,
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
                retryableFailure = true;
            });
            if (retryableFailure) {
                scheduleRefreshRetry(input);
            }
            return;
        }
        if (refreshResult.outcome === 'gap_or_cursor_expired') {
            const issueCode = 'follow_refresh_gap_or_cursor_expired';
            let recoveryAdmitted = false;
            await applyStatusMutation(async () => {
                if (!input.isCurrent()) return;
                recoveryAdmitted = true;
                input.state.refreshIssueCode = issueCode;
                const observedAtMs = now();
                await publishFollowStatus(
                    input.sessionId,
                    input.state.actual?.resource ?? input.state.source?.resource ?? null,
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
            });
            if (!recoveryAdmitted) return;
            const recovery = await refreshResult.recover();
            if (recovery?.outcome === 'resync_required') {
                // The one bounded read could not account for the whole gapped interval.
                // Do NOT publish 'resynced' over a cursor that skipped history: route the
                // EXISTING resync_required state (same branch as a replaced source), which
                // retires this authority and forces a fresh acquisition.
                await handleRefreshResult({ ...input, result: recovery });
                return;
            }
            await applyStatusMutation(async () => {
                if (!input.isCurrent()) return;
                input.state.refreshIssueCode = null;
                const recoveredAtMs = now();
                await publishFollowStatus(
                    input.sessionId,
                    input.state.actual?.resource ?? input.state.source?.resource ?? null,
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
            });
            return;
        }
        if (
            refreshResult.outcome === 'already_current'
            || refreshResult.outcome === 'advanced'
        ) {
            clearRefreshRetry(input.state);
        }
        if (input.state.refreshIssueCode === 'follow_refresh_resync_required') {
            return;
        }
        if (input.state.refreshIssueCode) {
            await applyStatusMutation(async () => {
                if (!input.isCurrent() || !input.state.refreshIssueCode) return;
                const recoveredIssueCode = input.state.refreshIssueCode;
                input.state.refreshIssueCode = null;
                const recoveredAtMs = now();
                await publishFollowStatus(
                    input.sessionId,
                    input.state.actual?.resource ?? input.state.source?.resource ?? null,
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
            });
        }
    };

    const publishRefreshFailure = async (
        sessionId: string,
        state: SessionFollowState,
        isCurrent: () => boolean,
        statusPublicationMode: RefreshStatusPublicationMode,
    ): Promise<void> => {
        let retryableFailure = false;
        const operation = async (): Promise<void> => {
            if (!isCurrent()) return;
            const issueCode = state.refreshIssueCode
                === 'follow_refresh_gap_or_cursor_expired'
                ? 'follow_refresh_resync_failed'
                : 'follow_refresh_failed';
            state.refreshIssueCode = issueCode;
            const observedAtMs = now();
            await publishFollowStatus(
                sessionId,
                state.actual?.resource ?? state.source?.resource ?? null,
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
            retryableFailure = true;
        };
        if (statusPublicationMode === 'inline') {
            await operation();
        } else {
            await runSessionExclusive(sessionId, operation);
        }
        if (retryableFailure) {
            scheduleRefreshRetry({ sessionId, state, isCurrent });
        }
    };

    const startTranscriptRefresh = (
        sessionId: string,
        state: SessionFollowState,
        statusPublicationMode: RefreshStatusPublicationMode,
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
                                statusPublicationMode,
                            });
                        } catch {
                            if (isCurrent()) {
                                await publishRefreshFailure(
                                    sessionId,
                                    state,
                                    isCurrent,
                                    statusPublicationMode,
                                );
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
                            statusPublicationMode,
                        });
                    } catch {
                        const isCurrent = () =>
                            state.actual === actual
                            && !actual.released
                            && state.source === refreshSource;
                        if (!isCurrent()) continue;
                        await publishRefreshFailure(
                            sessionId,
                            state,
                            isCurrent,
                            statusPublicationMode,
                        );
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
            return startTranscriptRefresh(
                sessionId,
                state,
                statusPublicationMode,
            );
        });
        state.refreshInFlight = pump;
        return pump;
    };

    const scheduleExpiry = (leaseId: string, sessionId: string): void => {
        const recordKey = viewerLeaseKey(sessionId, leaseId);
        const record = viewerLeasesById.get(recordKey);
        if (!record || record.sessionId !== sessionId) return;
        clearViewerTimer(record);
        record.expiryTimer = setTimer(() => {
            void runSessionExclusive(sessionId, async () => {
                const current = viewerLeasesById.get(recordKey);
                if (current !== record) return;
                forgetViewerLease(recordKey);
                await reconcile(sessionId, {
                    activeReason: 'background_follow',
                    propagateAcquisitionError: false,
                });
            });
        }, Math.max(0, record.expiresAtMs - now()));
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
            forgetViewerLease(recordKey);
        }
        backgroundFollowEnabledBySessionId.delete(sessionId);
        const state = statesBySessionId.get(sessionId);
        if (state) clearRefreshRetry(state);
        const releaseResult = state
            ? await releaseActual(sessionId, state, {
                status: 'paused',
                reason,
            }, {
                kind: 'manager_terminal',
            })
            : 'none';
        if (state) {
            await retryPendingFollowStatus(sessionId, state);
        }
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
            return await runSessionExclusive(input.sessionId, async () => {
                if (disposed) {
                    throw new ExternalSessionFollowFailureError(
                        'daemon_unavailable',
                        'External Session follow lease manager is disposed',
                    );
                }
                const attached = admitViewerLease({
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
                    expiresAtMs: attached.expiresAtMs,
                    acceptedTailCursor: input.requestTranscriptRefresh
                        && input.resource?.retirementSignal?.aborted !== true
                        && typeof input.acceptedTailCursor === 'string'
                        && input.acceptedTailCursor.trim().length > 0
                        ? input.acceptedTailCursor.trim()
                        : null,
                    requestTranscriptRefresh: input.requestTranscriptRefresh ?? null,
                    onSourceReplaced: null,
                    refreshDelivery: 'session_invalidation',
                    expiryTimer: null,
                });
                try {
                    await reconcile(input.sessionId, {
                        activeReason: 'viewer_attached',
                        propagateAcquisitionError: true,
                    });
                } catch (error) {
                    forgetViewerLease(recordKey);
                    throw error;
                }
                scheduleExpiry(attached.leaseId, input.sessionId);
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
            acceptedTailCursor: string | null;
            resource: ExternalSessionFollowResource;
            acquireFollowLease: FollowLeaseAcquirer;
            requestTranscriptRefresh: CursorRefreshRequester;
            onSourceReplaced?: () => Promise<void>;
        }>) {
            const attached = await runSessionExclusive(input.sessionId, async () => {
                if (disposed) {
                    throw new ExternalSessionFollowFailureError(
                        'daemon_unavailable',
                        'External Session follow lease manager is disposed',
                    );
                }
                const viewer = admitViewerLease({
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
                    expiresAtMs: viewer.expiresAtMs,
                    acceptedTailCursor: input.acceptedTailCursor,
                    requestTranscriptRefresh: input.requestTranscriptRefresh,
                    onSourceReplaced: input.onSourceReplaced ?? null,
                    refreshDelivery: 'scoped_listener',
                    expiryTimer: null,
                });
                let reconciliation: Awaited<ReturnType<typeof reconcile>>;
                try {
                    reconciliation = await reconcile(input.sessionId, {
                        activeReason: 'viewer_attached',
                        propagateAcquisitionError: true,
                    });
                } catch (error) {
                    forgetViewerLease(recordKey);
                    throw error;
                }
                const state = stateFor(input.sessionId);
                const acceptedTailCursor = input.acceptedTailCursor?.trim()
                    || reconciliation.followLease?.readAcceptedCursor?.()?.trim()
                    || state.actual?.readAcceptedCursor?.()?.trim()
                    || null;
                if (!acceptedTailCursor) {
                    forgetViewerLease(recordKey);
                    await reconcile(input.sessionId, {
                        activeReason: 'background_follow',
                        propagateAcquisitionError: false,
                    });
                    throw new ExternalSessionFollowFailureError(
                        'follow_unavailable',
                        'External Session follow did not establish an accepted cursor',
                    );
                }
                const record = viewerLeasesById.get(recordKey);
                if (!record) {
                    throw new ExternalSessionFollowFailureError(
                        'follow_unavailable',
                        'External Session scoped follow retired during admission',
                    );
                }
                record.acceptedTailCursor = acceptedTailCursor;
                return { ...viewer, acceptedTailCursor };
            });
            let released = false;
            return Object.freeze({
                leaseId: attached.leaseId,
                acceptedTailCursor: attached.acceptedTailCursor,
                release: async () => {
                    if (released) return;
                    released = true;
                    await runSessionExclusive(input.sessionId, async () => {
                        forgetViewerLease(
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
            return await runSessionExclusive(input.sessionId, async () => {
                const detached = detachViewerLease(input);
                if (!detached.detached) return detached;
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
            return await runSessionExclusive(input.sessionId, async () => {
                if (disposed) {
                    throw new ExternalSessionFollowFailureError(
                        'daemon_unavailable',
                        'External Session follow lease manager is disposed',
                    );
                }
                backgroundFollowEnabledBySessionId.set(input.sessionId, input.enabled);
                updateSource(
                    input.sessionId,
                    input.acquireFollowLease,
                    undefined,
                    input.resource,
                );
                const result = await reconcile(input.sessionId, {
                    activeReason: countActiveViewerLeases(input.sessionId) > 0
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
            return await runSessionExclusive(input.sessionId, async () => {
                if (disposed) {
                    throw new ExternalSessionFollowFailureError(
                        'daemon_unavailable',
                        'External Session follow lease manager is disposed',
                    );
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
                    forgetViewerLease(recordKey);
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
                clearRefreshRetry(state);
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
                        state.source?.resource ?? null,
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
            return await runSessionExclusive(input.sessionId, async () => {
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
                clearRefreshRetry(state);
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
            return await runSessionExclusive(input.sessionId, async () => {
                if (disposed) {
                    throw new ExternalSessionFollowFailureError(
                        'daemon_unavailable',
                        'External Session follow lease manager is disposed',
                    );
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
                        state.source?.resource ?? null,
                        'reacquiring',
                        'follow_suspension_released',
                    );
                }
                const result = await reconcile(input.sessionId, {
                    activeReason: countActiveViewerLeases(input.sessionId) > 0
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
            return await runSessionExclusive(input.sessionId, async () =>
                await releaseSessionNow(input.sessionId, 'archived'));
        },

        async releaseSessionsForCredentialInvalidation() {
            return await runBarrierExclusive(async () => {
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
            return await runBarrierExclusive(async () => {
                if (disposed) return;
                disposed = true;
                for (const record of viewerLeasesById.values()) clearViewerTimer(record);
                viewerLeasesById.clear();
                backgroundFollowEnabledBySessionId.clear();
                for (const [sessionId, state] of statesBySessionId) {
                    state.source?.removeRetirementListener?.();
                    clearRefreshRetry(state);
                    await releaseActual(sessionId, state, {
                        status: 'paused',
                        reason: 'daemon_disconnected',
                    }, {
                        kind: 'manager_terminal',
                    });
                    await retryPendingFollowStatus(sessionId, state);
                }
                statesBySessionId.clear();
            });
        },

        countActiveLeases(sessionId: string): number {
            return countActiveViewerLeases(sessionId);
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
            if (state.refreshRetryTimer !== null) {
                return { requested: true, coalesced: true } as const;
            }
            if (state.refreshInFlight) {
                state.refreshPending = true;
                return { requested: true, coalesced: true } as const;
            }
            clearRefreshRetry(state);
            await startTranscriptRefresh(
                input.sessionId,
                state,
                'session_exclusive',
            );
            return { requested: true, coalesced: false } as const;
        },
    };
}
