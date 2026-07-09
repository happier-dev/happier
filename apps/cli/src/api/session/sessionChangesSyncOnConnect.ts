import type { ManagedConnectionSupervisor } from '@happier-dev/connection-supervisor';
import {
    SessionCatchUpAuthorizationV1Schema,
    type SessionCatchUpAuthorizationV1,
} from '@happier-dev/protocol';

import { fetchChanges } from '../changes';
import { serializeAxiosErrorForLog } from '../client/serializeAxiosErrorForLog';
import { handleRequestAuthenticationFailure } from '@/api/connection/requestSupervision/reportRequestOutcomeToSupervisor';
import { readKnownPendingQueueState, type KnownPendingQueueState } from './pendingQueueState';
import type { SessionSnapshotRefreshReason } from './sessionSnapshotRefreshReason';

export type SessionCatchUpAuthorization = SessionCatchUpAuthorizationV1;

export function readSessionCatchUpAuthorization(value: unknown): SessionCatchUpAuthorization | null {
    const parsed = SessionCatchUpAuthorizationV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

export type SessionCatchUpRequest = Readonly<{
    afterSeq: number;
    authorization: SessionCatchUpAuthorization;
}>;

export function isV2ChangesSyncEnabled(flagValue: string | undefined): boolean {
    if (!flagValue) return true;
    return ['true', '1', 'yes'].includes(flagValue.toLowerCase());
}

function reportReconnectCatchUpFailure(params: { onDebug: (message: string, data?: unknown) => void }, error: unknown): void {
    params.onDebug('[API] Failed to catch up session messages after reconnect', {
        error: serializeAxiosErrorForLog(error),
    });
}

function readSessionMessageChangeHint(hint: unknown): { seq: number } | null {
    if (!hint || typeof hint !== 'object') return null;
    const record = hint as Record<string, unknown>;
    const seq =
        typeof record.lastMessageSeq === 'number'
            ? record.lastMessageSeq
            : typeof record.updatedMessageSeq === 'number'
                ? record.updatedMessageSeq
                : null;
    if (seq === null || !Number.isSafeInteger(seq) || seq < 0) return null;
    return { seq };
}

function snapshotReasonForChangesFallback(reason: 'connect' | 'reconnect' | 'stale-safety'): SessionSnapshotRefreshReason {
    if (reason === 'reconnect') return 'reconnect';
    if (reason === 'connect') return 'connect';
    return 'degraded-socket';
}

export async function runSessionChangesSyncOnConnect(params: {
    reason: 'connect' | 'reconnect' | 'stale-safety';
    token: string;
    sessionId: string;
    lastObservedMessageSeq: number;
    getAccountId: () => Promise<string | null>;
    readChangesCursor: (accountId: string) => Promise<number>;
    writeChangesCursor: (accountId: string, cursor: number) => Promise<void>;
    catchUpSessionMessages: (request: SessionCatchUpRequest) => Promise<void>;
    syncSessionSnapshotFromServer: (opts: { reason: SessionSnapshotRefreshReason }) => Promise<void>;
    applyPendingQueueState?: ((state: KnownPendingQueueState) => void) | null;
    connectionSupervisor?: ManagedConnectionSupervisor | null;
    onDebug: (message: string, data?: unknown) => void;
}): Promise<void> {
    const accountId = await params.getAccountId();
    if (!accountId) return;

    const CHANGES_PAGE_LIMIT = 200;
    const after = await params.readChangesCursor(accountId);
    const result = await fetchChanges({ token: params.token, after, limit: CHANGES_PAGE_LIMIT });
    if (result.status === 'cursor-gone') {
        await params.writeChangesCursor(accountId, result.currentCursor);
        // If the server indicates the cursor is invalid (future cursor or pruned floor),
        // force a snapshot rebuild so we don't miss deletion signals.
        if (params.reason === 'reconnect') {
            try {
                await params.catchUpSessionMessages({
                    afterSeq: params.lastObservedMessageSeq,
                    authorization: 'reconnect_watermark',
                });
            } catch (error) {
                reportReconnectCatchUpFailure(params, error);
            }
        }
        void params.syncSessionSnapshotFromServer({ reason: snapshotReasonForChangesFallback(params.reason) });
        return;
    }
    if (result.status !== 'ok') {
        if (handleRequestAuthenticationFailure({
            supervisor: params.connectionSupervisor,
            error: result.error,
            hadAuth: true,
        })) {
            return;
        }

        // Backwards compatibility: old servers may not support /v2/changes yet (e.g. 404).
        // On reconnect, fall back to the snapshot-based convergence path.
        if (params.reason === 'reconnect') {
            try {
                await params.catchUpSessionMessages({
                    afterSeq: params.lastObservedMessageSeq,
                    authorization: 'reconnect_watermark',
                });
            } catch (error) {
                reportReconnectCatchUpFailure(params, error);
            }
            void params.syncSessionSnapshotFromServer({ reason: snapshotReasonForChangesFallback(params.reason) });
        }
        return;
    }

    const changes = result.response.changes;
    const nextCursor = result.response.nextCursor;

    let transcriptCatchUpFailed = false;
    const catchUpSessionMessages = async (request: SessionCatchUpRequest): Promise<void> => {
        try {
            await params.catchUpSessionMessages(request);
        } catch (error) {
            transcriptCatchUpFailed = true;
            reportReconnectCatchUpFailure(params, error);
        }
    };

    let hasRelevantSessionChange = false;
    let shouldCatchUpSessionMessages = false;
    let shouldSyncSnapshotFallback = false;
    for (const change of changes) {
        const isRelevant = (change.kind === 'session' || change.kind === 'share') && change.entityId === params.sessionId;
        if (!isRelevant) continue;
        hasRelevantSessionChange = true;
        if (change.kind === 'share') {
            shouldSyncSnapshotFallback = params.reason !== 'connect';
            continue;
        }
        const pendingQueueState = readKnownPendingQueueState(change.hint);
        if (pendingQueueState) {
            params.applyPendingQueueState?.(pendingQueueState);
            continue;
        }
        const messageChange = readSessionMessageChangeHint(change.hint);
        if (messageChange) {
            if (params.reason !== 'connect' && messageChange.seq > params.lastObservedMessageSeq) {
                shouldCatchUpSessionMessages = true;
            }
            continue;
        }
        shouldSyncSnapshotFallback = params.reason !== 'connect';
    }
    if (changes.length >= CHANGES_PAGE_LIMIT) {
        // Slow-path: too many coalesced changes. Snapshot sync gets us back to a known-good state;
        // session transcript catch-up is only needed after reconnect.
        if (params.reason === 'reconnect') {
            await catchUpSessionMessages({
                afterSeq: params.lastObservedMessageSeq,
                authorization: 'reconnect_watermark',
            });
        }
        void params.syncSessionSnapshotFromServer({ reason: snapshotReasonForChangesFallback(params.reason) });
        if (!transcriptCatchUpFailed) {
            await params.writeChangesCursor(accountId, nextCursor);
        }
        return;
    }

    if (hasRelevantSessionChange && params.reason === 'reconnect') {
        await catchUpSessionMessages({
            afterSeq: params.lastObservedMessageSeq,
            authorization: 'reconnect_watermark',
        });
        void params.syncSessionSnapshotFromServer({ reason: snapshotReasonForChangesFallback(params.reason) });
    }

    if (shouldCatchUpSessionMessages && params.reason !== 'reconnect') {
        await catchUpSessionMessages({
            afterSeq: params.lastObservedMessageSeq,
            authorization: 'reconnect_watermark',
        });
    }

    if (shouldSyncSnapshotFallback) {
        void params.syncSessionSnapshotFromServer({ reason: snapshotReasonForChangesFallback(params.reason) });
    }

    if (!transcriptCatchUpFailed) {
        await params.writeChangesCursor(accountId, nextCursor);
    }
}
