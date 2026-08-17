import {
    deriveLatestPendingRequestObservedAtFromSession,
    derivePendingRequestFlagsFromSession,
    readPendingAgentStateCompletedRequestSignature,
    readPendingAgentStateRequestSignature,
} from '@/sync/domains/session/pending/listPendingSessionRequests';
import {
    deriveSessionRuntimePresentationState,
    isFreshTimestamp,
    SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS,
} from '@/sync/domains/session/attention/runtimePresentation';
import { readStoredSessionMessages } from '@/sync/domains/messages/readStoredSessionMessages';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { StorageState } from '@/sync/store/types';

import {
    createSessionRuntimeFreshnessLedger,
    createSessionSignatureLedger,
    isBeforeFreshnessBoundary,
} from '@/activity/attention/sessionAttentionSignatureLedger';

export type FaviconPermissionSnapshot = Readonly<{
    hasFreshPermission: boolean;
    nextRefreshDelayMs: number | null;
}>;

function collectRecordIds<T>(record: Readonly<Record<string, T>> | null | undefined): string[] {
    const ids: string[] = [];
    if (!record || typeof record !== 'object') return ids;
    for (const id in record) {
        if (!Object.prototype.hasOwnProperty.call(record, id)) continue;
        ids.push(id);
    }
    return ids;
}

function readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function readFreshnessRefreshDelayMs(timestamp: number | null | undefined, nowMs: number): number | null {
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return null;
    const normalizedTimestamp = Math.trunc(timestamp);
    if (!isFreshTimestamp(normalizedTimestamp, nowMs, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS)) return null;
    return Math.max(
        0,
        normalizedTimestamp + SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - nowMs + 1,
    );
}

function buildSessionPermissionSignature(session: Session): string {
    const agentState = session.agentState;
    return [
        session.id,
        session.active === true ? 1 : 0,
        readNumber(session.activeAt) ?? '',
        session.presence,
        session.thinking === true ? 1 : 0,
        readNumber(session.thinkingAt) ?? '',
        session.latestTurnStatus ?? '',
        readNumber(session.latestTurnStatusObservedAt) ?? '',
        readNumber(session.meaningfulActivityAt) ?? '',
        readNumber(session.pendingPermissionRequestCount) ?? '',
        readNumber(session.pendingUserActionRequestCount) ?? '',
        readNumber(session.pendingRequestObservedAt) ?? '',
        readPendingAgentStateRequestSignature(agentState),
        readPendingAgentStateCompletedRequestSignature(agentState),
    ].join('\u001f');
}

function buildSessionMessagesPermissionSignature(
    sessionMessages: StorageState['sessionMessages'][string] | undefined,
): string {
    if (!sessionMessages) return '';
    return [
        sessionMessages.isLoaded === true ? 1 : 0,
        readNumber(sessionMessages.messagesVersion) ?? '',
        readNumber(sessionMessages.latestReadyEventSeq) ?? '',
        readNumber(sessionMessages.latestReadyEventAt) ?? '',
        sessionMessages.messageIdsOldestFirst?.length ?? '',
    ].join('\u001f');
}

function deriveFreshPermissionRefreshDelayMs(
    session: Session,
    pendingRequestObservedAt: number | null,
    nowMs: number,
): number | null {
    const delays: number[] = [];
    const addDelay = (timestamp: number | null | undefined) => {
        const delay = readFreshnessRefreshDelayMs(timestamp, nowMs);
        if (delay !== null) delays.push(delay);
    };

    addDelay(pendingRequestObservedAt);
    addDelay(session.latestTurnStatusObservedAt);
    addDelay(session.thinkingAt);
    addDelay(session.activeAt);

    return delays.length === 0 ? null : Math.min(...delays);
}

function deriveFaviconPermissionSnapshotFromSessions(
    state: StorageState,
    sessionIds: readonly string[],
    nowMs: number,
): FaviconPermissionSnapshot {
    let hasFreshPermission = false;
    let nextRefreshDelayMs: number | null = null;

    for (const sessionId of sessionIds) {
        const session = state.sessions[sessionId];
        if (!session) continue;
        const messages = readStoredSessionMessages(state, session.id);
        const pendingFlags = derivePendingRequestFlagsFromSession(session, messages);
        const pendingRequestObservedAt = deriveLatestPendingRequestObservedAtFromSession(session, messages);
        const runtimeState = deriveSessionRuntimePresentationState({
            active: session.active,
            activeAt: session.activeAt,
            presence: session.presence,
            thinking: session.thinking,
            thinkingAt: session.thinkingAt,
            latestTurnStatus: session.latestTurnStatus ?? null,
            latestTurnStatusObservedAt: session.latestTurnStatusObservedAt ?? null,
            meaningfulActivityAt: session.meaningfulActivityAt ?? null,
            lastRuntimeIssue: session.lastRuntimeIssue ?? null,
            hasPendingPermissionRequests: pendingFlags.hasPendingPermissionRequests,
            hasPendingUserActionRequests: pendingFlags.hasPendingUserActionRequests,
            pendingRequestObservedAt,
            nowMs,
        });

        if (!runtimeState.freshPermissionRequired) continue;

        hasFreshPermission = true;
        const refreshDelayMs = deriveFreshPermissionRefreshDelayMs(session, pendingRequestObservedAt, nowMs);
        if (refreshDelayMs !== null) {
            nextRefreshDelayMs = nextRefreshDelayMs === null
                ? refreshDelayMs
                : Math.min(nextRefreshDelayMs, refreshDelayMs);
        }
    }

    return {
        hasFreshPermission,
        nextRefreshDelayMs,
    };
}

type SessionMessagesValue = StorageState['sessionMessages'][string] | undefined;

/**
 * The favicon indicator is mounted at the web app root, so this selector runs on
 * every store notification for the whole account.
 *
 * It used to answer "did anything that could move the favicon change?" by
 * rebuilding sorted, joined signature strings over every session — a sort plus
 * three account-sized joins per evaluation, allocating a string per session.
 * `sessionAttentionSignatureLedger` answers the same question with a revision
 * counter, where an unchanged session costs one identity comparison and
 * allocates nothing.
 *
 * Runtime freshness is the one input that moves without the store moving, so the
 * freshness ledger's recorded boundary — not a `Date.now()` read inside a
 * signature — decides when a time-only re-derivation is due.
 */
export function createFaviconPermissionSnapshotSelector(): (state: StorageState) => FaviconPermissionSnapshot {
    const sessionLedger = createSessionSignatureLedger<Session>(buildSessionPermissionSignature);
    const sessionMessagesLedger = createSessionSignatureLedger<SessionMessagesValue>(
        buildSessionMessagesPermissionSignature,
    );
    const freshnessLedger = createSessionRuntimeFreshnessLedger();
    let previousRevisions: string | null = null;
    let previousSnapshot: FaviconPermissionSnapshot | null = null;
    let previousSessions: StorageState['sessions'] | null = null;
    let previousSessionMessages: StorageState['sessionMessages'] | null = null;

    return (state) => {
        const nowMs = Date.now();
        const isFreshnessStable = isBeforeFreshnessBoundary(nowMs, [
            freshnessLedger.readNextBoundaryAtMs(),
        ]);
        // A store notification that moved neither record cannot move this
        // snapshot, so it must cost O(1) rather than an account-sized pass. The
        // reuse only holds inside the earliest freshness boundary the ledger
        // recorded, because freshness expiry moves the value with no store write.
        if (
            previousSnapshot !== null
            && previousSessions === state.sessions
            && previousSessionMessages === state.sessionMessages
            && isFreshnessStable
        ) {
            return previousSnapshot;
        }
        previousSessions = state.sessions;
        previousSessionMessages = state.sessionMessages;

        // The favicon selector is evaluated against partial states in tests and
        // during early hydration, where the messages record may not exist yet.
        const sessionMessages = state.sessionMessages ?? {};
        const revisions = [
            sessionLedger.sync(state.sessions, (id) => state.sessions[id]),
            sessionMessagesLedger.sync(state.sessions, (id) => sessionMessages[id]),
            freshnessLedger.sync({
                sessions: state.sessions,
                sessionMessages,
                nowMs,
                readSessionSignature: sessionLedger.readSignature,
                readSessionMessagesSignature: sessionMessagesLedger.readSignature,
            }),
        ].join('\u001c');

        if (revisions === previousRevisions && previousSnapshot) {
            return previousSnapshot;
        }

        previousRevisions = revisions;
        previousSnapshot = deriveFaviconPermissionSnapshotFromSessions(
            state,
            collectRecordIds(state.sessions),
            nowMs,
        );
        return previousSnapshot;
    };
}
