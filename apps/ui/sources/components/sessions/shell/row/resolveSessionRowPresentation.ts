import { deriveSessionListAttentionState } from '../../../../sync/domains/session/listing/deriveSessionListActivity';
import type { SessionStatus } from '@/utils/sessions/sessionUtils';

export function shouldEmphasizeSessionRowTitle(input: Readonly<{
    hasUnreadMessages: boolean;
    pendingCount: number;
    sessionStatus: SessionStatus;
}>): boolean {
    return deriveSessionListAttentionState({
        hasUnreadMessages: input.hasUnreadMessages,
        pendingCount: input.pendingCount,
        sessionState: input.sessionStatus.state,
    }) !== 'quiet';
}

export function shouldShowMinimalSessionStatusLine(sessionStatus: SessionStatus): boolean {
    if (sessionStatus.shouldShowStatus !== true) return false;
    if (!sessionStatus.statusText.trim()) return false;
    const attentionState = deriveSessionListAttentionState({
        hasUnreadMessages: false,
        pendingCount: 0,
        sessionState: sessionStatus.state,
    });
    return attentionState === 'thinking' || attentionState === 'permission_required' || attentionState === 'action_required';
}
