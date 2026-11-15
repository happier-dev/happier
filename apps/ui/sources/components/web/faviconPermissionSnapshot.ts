import {
    deriveLatestPendingRequestObservedAtFromSession,
    derivePendingRequestFlagsFromSession,
    readPendingAgentStateCompletedRequestSignature,
    readPendingAgentStateRequestSignature,
    readStoredTranscriptRequestStatesCache,
} from '@/sync/domains/session/pending/listPendingSessionRequests';
import {
    projectUiSessionRuntimeAwareness,
    readSessionRuntimePresentationFreshnessExpirations,
} from '@/sync/domains/session/attention/runtimePresentation';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { StorageState } from '@/sync/store/types';
import { readSessionViewerAttentionSignature, resolveSessionPersonalAttentionForViewer } from '@/sync/domains/session/readState/sessionViewerAttention';
import { isSessionAdmittedToPersonalActivity } from '@/activity/attention/isSessionAdmittedToPersonalActivity';

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

function buildSessionPermissionSignature(session: Session): string {
    const agentState = session.agentState;
    return [
        session.id,
        readSessionViewerAttentionSignature(session),
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

function deriveFaviconPermissionSnapshotFromSessions(
    state: StorageState,
    sessionIds: readonly string[],
    nowMs: number,
): FaviconPermissionSnapshot {
    let hasFreshPermission = false;
    let nextRefreshDelayMs: number | null = null;

    for (const sessionId of sessionIds) {
        const session = state.sessions[sessionId];
        if (!session || !isSessionAdmittedToPersonalActivity(session)) continue;
        // Every streamed apply re-derives this for all Sessions: read the Store's incrementally
        // maintained request states, never a transcript walk.
        const statesCache = readStoredTranscriptRequestStatesCache(state.sessionMessages?.[session.id], session);
        const personal = resolveSessionPersonalAttentionForViewer(session, nowMs, undefined, undefined, undefined, undefined, statesCache);
        if (!personal.reasons.includes('permission_required')) continue;
        if (session.viewer !== undefined) {
            hasFreshPermission = true;
            continue;
        }
        const pendingFlags = derivePendingRequestFlagsFromSession(session, undefined, statesCache);
        const pendingRequestObservedAt = deriveLatestPendingRequestObservedAtFromSession(session, undefined, statesCache);
        const runtimeInput = {
            id: session.id,
            serverId: session.serverId,
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
        };
        const runtimeState = projectUiSessionRuntimeAwareness(runtimeInput);

        if (!runtimeState.freshPermissionRequired) continue;

        hasFreshPermission = true;
        const expirations = readSessionRuntimePresentationFreshnessExpirations(runtimeInput, nowMs);
        const refreshDelayMs = expirations.length === 0
            ? null
            : Math.max(0, Math.min(...expirations) - nowMs + 1);
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
 * The Messages owner publishes tool and transcript-lifecycle changes separately
 * from assistant text. Only those changes can alter transcript permission facts;
 * ordinary text must not walk the Account's Sessions or replace this snapshot.
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
    let previousToolVersion: number | null = null;

    return (state) => {
        const nowMs = Date.now();
        const isFreshnessStable = isBeforeFreshnessBoundary(nowMs, [
            freshnessLedger.readNextBoundaryAtMs(),
        ]);
        // Freshness expiry still re-derives without a store write, using the
        // existing runtime boundary rather than a second attention policy.
        if (
            previousSnapshot !== null
            && previousSessions === state.sessions
            && previousToolVersion === state.sessionMessageToolVersion
            && isFreshnessStable
        ) {
            return previousSnapshot;
        }
        previousSessions = state.sessions;
        previousToolVersion = state.sessionMessageToolVersion;

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
        const derived = deriveFaviconPermissionSnapshotFromSessions(
            state,
            collectRecordIds(state.sessions),
            nowMs,
        );
        // A Session signature moves far more often than the answer does: publish a new snapshot
        // only when the answer or its refresh deadline differs, so the always-mounted indicator
        // does not re-render for it.
        if (previousSnapshot === null
            || previousSnapshot.hasFreshPermission !== derived.hasFreshPermission
            || previousSnapshot.nextRefreshDelayMs !== derived.nextRefreshDelayMs) {
            previousSnapshot = derived;
        }
        return previousSnapshot;
    };
}
