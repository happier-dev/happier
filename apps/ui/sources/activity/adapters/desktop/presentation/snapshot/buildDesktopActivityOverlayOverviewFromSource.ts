import { buildSessionActivityAttention } from '@/activity/attention/buildSessionActivityAttention';
import type { ActivityOverviewSnapshot, SessionActivityAttention } from '@/activity/attention/activityAttentionTypes';
import {
    listSessionListLookupActiveSessionIds,
    listSessionListLookupServerSessions,
    type SessionServerLookupStateLike,
} from '@/sync/domains/session/listing/sessionListLookupState';
import type { Session } from '@/sync/domains/state/storageTypes';

import type { DesktopActivityOverlaySource } from '../../runtime/useDesktopActivityOverlaySource';

function sortCandidates(left: SessionActivityAttention, right: SessionActivityAttention): number {
    if (left.priority !== right.priority) {
        return right.priority - left.priority;
    }
    if (left.session.updatedAt !== right.session.updatedAt) {
        return right.session.updatedAt - left.session.updatedAt;
    }
    return left.sessionId.localeCompare(right.sessionId);
}

function buildLookupState(source: DesktopActivityOverlaySource): SessionServerLookupStateLike {
    return {
        sessions: source.sessionsById,
        sessionListRenderables: source.sessionListRenderablesById,
        sessionListIndexByServerId: source.sessionListIndexByServerId,
        concurrentSessionListCacheByServerId: source.concurrentSessionListCacheByServerId,
    };
}

function collectLookupSessionIds(source: DesktopActivityOverlaySource): readonly string[] {
    if (!source.isDataReady) {
        return [];
    }

    const lookupState = buildLookupState(source);
    const sessionIds: string[] = [];
    const seenSessionIds = new Set<string>();

    for (const sessionId of listSessionListLookupActiveSessionIds(lookupState)) {
        if (!sessionId || seenSessionIds.has(sessionId)) {
            continue;
        }
        seenSessionIds.add(sessionId);
        sessionIds.push(sessionId);
    }

    for (const entry of listSessionListLookupServerSessions(lookupState)) {
        const sessionId = entry.session.id.trim();
        if (seenSessionIds.has(sessionId)) {
            continue;
        }

        seenSessionIds.add(sessionId);
        sessionIds.push(sessionId);
    }

    return sessionIds;
}

function collectSourceSessions(source: DesktopActivityOverlaySource): readonly Session[] {
    const sessions: Session[] = [];

    for (const sessionId of collectLookupSessionIds(source)) {
        const session = source.sessionsById[sessionId];
        if (!session) {
            continue;
        }
        sessions.push(session);
    }

    return sessions;
}

export function buildDesktopActivityOverlayOverviewFromSource(params: Readonly<{
    source: DesktopActivityOverlaySource;
    nowMs: number;
}>): ActivityOverviewSnapshot {
    const candidates = collectSourceSessions(params.source)
        .map((session) => buildSessionActivityAttention({
            session,
            nowMs: params.nowMs,
        }))
        .sort(sortCandidates);

    let unread = 0;
    let permissionRequired = 0;
    let actionRequired = 0;
    let queuedInput = 0;
    let thinking = 0;
    let totalAttention = 0;

    for (const candidate of candidates) {
        if (candidate.reasons.hasUnread) unread += 1;
        if (candidate.reasons.hasPendingPermissionRequests) permissionRequired += 1;
        if (candidate.reasons.hasPendingUserActionRequests) actionRequired += 1;
        if (candidate.reasons.hasQueuedUserInput) queuedInput += 1;
        if (candidate.reasons.isThinking) thinking += 1;
        if (candidate.hasAttention) totalAttention += 1;
    }

    return {
        counts: {
            unread,
            permissionRequired,
            actionRequired,
            queuedInput,
            thinking,
            totalAttention,
        },
        candidates,
    };
}
