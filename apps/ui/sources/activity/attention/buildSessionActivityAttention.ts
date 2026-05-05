import { deriveSessionAttentionFlags, type SessionAttentionOptions } from '@/sync/domains/session/attention/sessionAttention';
import { deriveSessionListAttentionState } from '@/sync/domains/session/listing/deriveSessionListActivity';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import { getSessionName, getSessionStatus, getSessionSubtitle } from '@/utils/sessions/sessionUtils';

import type { SessionActivityAttention } from './activityAttentionTypes';
import { isRecentActivityCompletion } from './activityCompletionTiming';

function resolveAttentionPriority(state: SessionActivityAttention['attentionState']): number {
    switch (state) {
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

export function buildSessionActivityAttention(params: Readonly<{
    session: Session;
    sessionOptions?: SessionAttentionOptions;
    nowMs?: number;
}>): SessionActivityAttention {
    const status = getSessionStatus(buildSessionListRenderableFromSession(params.session), params.nowMs);
    const reasons = deriveSessionAttentionFlags(params.session, params.sessionOptions);
    const lastTurnCompletedAt = typeof params.session.lastTurnCompletedAt === 'number'
        && Number.isFinite(params.session.lastTurnCompletedAt)
        ? params.session.lastTurnCompletedAt
        : null;
    const derivedAttentionState = deriveSessionListAttentionState({
        hasUnreadMessages: reasons.hasUnread,
        pendingCount: params.session.pendingCount ?? 0,
        sessionState: status.state,
    });
    const attentionState = isRecentActivityCompletion(lastTurnCompletedAt, params.nowMs ?? Date.now())
        ? 'pending'
        : derivedAttentionState;

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
            hasPendingPermissionRequests: reasons.hasPendingPermissionRequests,
            hasPendingUserActionRequests: reasons.hasPendingUserActionRequests,
            hasQueuedUserInput: reasons.hasQueuedUserInput,
            isThinking: status.state === 'thinking',
        },
    };
}
