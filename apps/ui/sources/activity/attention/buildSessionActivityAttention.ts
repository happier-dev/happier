import { deriveSessionAttentionFlags, type SessionAttentionFlags, type SessionAttentionOptions } from '@/sync/domains/session/attention/sessionAttention';
import { deriveSessionListAttentionState } from '@/sync/domains/session/listing/deriveSessionListActivity';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Message } from '@/sync/domains/messages/messageTypes';
import {
    deriveLatestPendingRequestObservedAtFromSession,
    derivePendingRequestFlagsFromSession,
} from '@/sync/domains/session/pending/listPendingSessionRequests';
import { deriveSessionRuntimePresentationState } from '@/sync/domains/session/attention/runtimePresentation';
import type { Session } from '@/sync/domains/state/storageTypes';
import { getSessionName, getSessionStatus, getSessionSubtitle } from '@/utils/sessions/sessionUtils';

import type { SessionActivityAttention } from './activityAttentionTypes';
import { isRecentActivityCompletion } from './activityCompletionTiming';

function resolveAttentionPriority(state: SessionActivityAttention['attentionState']): number {
    switch (state) {
        case 'failed':
            return 700;
        case 'permission_required':
            return 600;
        case 'action_required':
            return 550;
        case 'thinking':
            return 400;
        case 'pending':
            return 300;
        case 'unread':
            return 200;
        case 'quiet':
        default:
            return 0;
    }
}

function readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function hasCompletedRequest(completedValue: unknown, requestId: string): boolean {
    if (!completedValue || typeof completedValue !== 'object') return false;
    const completed = completedValue as Record<string, { completedAt?: unknown } | undefined>;
    return completed[requestId]?.completedAt != null;
}

function readLatestPendingAgentRequestCreatedAt(session: Session): number | null {
    const requests = session.agentState?.requests;
    if (!requests || typeof requests !== 'object') return null;
    const completed = session.agentState?.completedRequests ?? null;
    let latest: number | null = null;
    for (const requestId in requests) {
        if (!Object.prototype.hasOwnProperty.call(requests, requestId)) continue;
        if (hasCompletedRequest(completed, requestId)) continue;
        const createdAt = readNumber(requests[requestId]?.createdAt);
        if (createdAt === null) continue;
        latest = latest === null ? createdAt : Math.max(latest, createdAt);
    }
    return latest;
}

function deriveActivityAttentionFlags(params: Readonly<{
    session: Session;
    sessionMessages?: readonly Message[];
    sessionOptions?: SessionAttentionOptions;
    nowMs?: number;
}>): Readonly<{
    flags: SessionAttentionFlags;
    pendingRequestObservedAt: number | null;
}> {
    const baseFlags = deriveSessionAttentionFlags(params.session, params.sessionOptions);
    const pendingFlags = derivePendingRequestFlagsFromSession(params.session, params.sessionMessages);
    const pendingRequestObservedAt = deriveLatestPendingRequestObservedAtFromSession(
        params.session,
        params.sessionMessages,
    ) ?? readLatestPendingAgentRequestCreatedAt(params.session);
    const runtimePresentation = deriveSessionRuntimePresentationState({
        active: params.session.active,
        activeAt: params.session.activeAt,
        presence: params.session.presence,
        thinking: params.session.thinking,
        thinkingAt: params.session.thinkingAt,
        latestTurnStatus: params.session.latestTurnStatus ?? null,
        latestTurnStatusObservedAt: params.session.latestTurnStatusObservedAt ?? null,
        meaningfulActivityAt: params.session.meaningfulActivityAt ?? null,
        lastRuntimeIssue: params.session.lastRuntimeIssue ?? null,
        hasPendingPermissionRequests: pendingFlags.hasPendingPermissionRequests,
        hasPendingUserActionRequests: pendingFlags.hasPendingUserActionRequests,
        pendingRequestObservedAt,
        nowMs: params.nowMs,
    });

    return {
        flags: {
            ...baseFlags,
            hasPendingPermissionRequests:
                params.session.active === true
                && params.sessionOptions?.showPendingPermissionRequests !== false
                && runtimePresentation.freshPermissionRequired,
            hasPendingUserActionRequests:
                params.session.active === true
                && params.sessionOptions?.showPendingUserActionRequests !== false
                && runtimePresentation.freshActionRequired,
        },
        pendingRequestObservedAt,
    };
}

export function buildSessionActivityAttention(params: Readonly<{
    session: Session;
    sessionMessages?: readonly Message[];
    sessionOptions?: SessionAttentionOptions;
    nowMs?: number;
}>): SessionActivityAttention {
    const renderableSession = buildSessionListRenderableFromSession(params.session);
    const status = getSessionStatus(renderableSession, params.nowMs);
    const {
        flags: reasons,
        pendingRequestObservedAt,
    } = deriveActivityAttentionFlags(params);
    const lastTurnCompletedAt = typeof params.session.lastTurnCompletedAt === 'number'
        && Number.isFinite(params.session.lastTurnCompletedAt)
        ? params.session.lastTurnCompletedAt
        : null;
    const derivedAttentionState = deriveSessionListAttentionState({
        hasUnreadMessages: reasons.hasUnread,
        pendingCount: 0,
        sessionState: status.state,
        latestTurnStatus: params.session.latestTurnStatus ?? null,
        lastRuntimeIssue: params.session.lastRuntimeIssue ?? null,
        active: renderableSession.active,
        activeAt: renderableSession.activeAt,
        presence: renderableSession.presence,
        thinking: renderableSession.thinking,
        thinkingAt: renderableSession.thinkingAt,
        latestTurnStatusObservedAt: renderableSession.latestTurnStatusObservedAt ?? null,
        pendingRequestObservedAt,
        nowMs: params.nowMs,
    });
    const pendingAttentionState = reasons.hasPendingPermissionRequests
        ? 'permission_required'
        : reasons.hasPendingUserActionRequests
            ? 'action_required'
            : derivedAttentionState;
    const attentionState = isRecentActivityCompletion(lastTurnCompletedAt, params.nowMs ?? Date.now())
        ? 'pending'
        : pendingAttentionState;

    return {
        session: params.session,
        sessionId: params.session.id,
        title: getSessionName(params.session),
        subtitle: getSessionSubtitle(params.session),
        attentionState,
        hasAttention: attentionState !== 'quiet',
        priority: resolveAttentionPriority(attentionState),
        lastTurnCompletedAt,
        reasons: {
            hasUnread: reasons.hasUnread,
            hasPendingPermissionRequests:
                reasons.hasPendingPermissionRequests || attentionState === 'permission_required',
            hasPendingUserActionRequests:
                reasons.hasPendingUserActionRequests || attentionState === 'action_required',
            hasQueuedUserInput: reasons.hasQueuedUserInput,
            isThinking: status.state === 'thinking',
        },
    };
}
