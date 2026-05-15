import {
    deriveSessionListAttentionState,
    type SessionListAttentionState,
} from '../../../../sync/domains/session/listing/deriveSessionListActivity';
import type { SessionStatus } from '@/utils/sessions/sessionUtils';

export type SessionListActiveColorModeV1 =
    | 'activityAndAttention'
    | 'attentionOnly'
    | 'allActive';

export type SessionRowTitleTone = 'quiet' | 'emphasized';
export type SessionRowTitleColorRole = 'primary' | 'secondary';

export function normalizeSessionListActiveColorMode(value: unknown): SessionListActiveColorModeV1 {
    return value === 'attentionOnly' || value === 'allActive'
        ? value
        : 'activityAndAttention';
}

export function deriveSessionRowTitleAttentionState(input: Readonly<{
    hasUnreadMessages: boolean;
    pendingCount: number;
    sessionStatus: SessionStatus;
}>): SessionListAttentionState {
    return deriveSessionListAttentionState({
        hasUnreadMessages: input.hasUnreadMessages,
        pendingCount: input.pendingCount,
        sessionState: input.sessionStatus.state,
    });
}

export function resolveSessionRowTitleColorRole(input: Readonly<{
    mode: SessionListActiveColorModeV1;
    selected: boolean;
    isConnected: boolean;
    isSessionActive: boolean;
    attentionState: SessionListAttentionState;
    titleTone: SessionRowTitleTone;
}>): SessionRowTitleColorRole {
    if (input.selected) return 'primary';
    if (!input.isConnected) return 'secondary';

    if (input.mode === 'allActive') {
        return input.isSessionActive || input.titleTone !== 'quiet' ? 'primary' : 'secondary';
    }

    if (input.mode === 'attentionOnly') {
        return isUserAttentionState(input.attentionState) ? 'primary' : 'secondary';
    }

    return input.titleTone === 'quiet' ? 'secondary' : 'primary';
}

function isUserAttentionState(attentionState: SessionListAttentionState): boolean {
    return attentionState === 'unread'
        || attentionState === 'pending'
        || attentionState === 'ready'
        || attentionState === 'failed'
        || attentionState === 'permission_required'
        || attentionState === 'action_required';
}
