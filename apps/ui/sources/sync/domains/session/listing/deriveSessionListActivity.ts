import type { SessionState } from '@/utils/sessions/sessionUtils';

export type SessionListSecondaryLineMode = 'status' | 'path';
export type SessionListAttentionState =
    | 'quiet'
    | 'unread'
    | 'pending'
    | 'thinking'
    | 'permission_required'
    | 'action_required';

export function deriveSessionListMeaningfulActivityAt(params: Readonly<{
    sessionCreatedAt: number | null | undefined;
    latestCommittedMessageCreatedAt: number | null | undefined;
    latestThinkingActivityAt: number | null | undefined;
    latestPendingMessageCreatedAt: number | null | undefined;
}>): number | null {
    let latest: number | null = null;

    const committed = params.latestCommittedMessageCreatedAt;
    if (typeof committed === 'number' && Number.isFinite(committed) && committed > 0) {
        latest = committed;
    }

    const thinking = params.latestThinkingActivityAt;
    if (typeof thinking === 'number' && Number.isFinite(thinking) && thinking > 0) {
        latest = latest == null ? thinking : Math.max(latest, thinking);
    }

    const pending = params.latestPendingMessageCreatedAt;
    if (typeof pending === 'number' && Number.isFinite(pending) && pending > 0) {
        latest = latest == null ? pending : Math.max(latest, pending);
    }

    const sessionCreatedAt = params.sessionCreatedAt;
    if (typeof sessionCreatedAt === 'number' && Number.isFinite(sessionCreatedAt) && sessionCreatedAt > 0) {
        latest = latest == null ? sessionCreatedAt : Math.max(latest, sessionCreatedAt);
    }

    return latest;
}

export function deriveSessionListAttentionState(input: Readonly<{
    hasUnreadMessages: boolean;
    pendingCount: number;
    sessionState: SessionState;
}>): SessionListAttentionState {
    if (input.sessionState === 'permission_required') return 'permission_required';
    if (input.sessionState === 'action_required') return 'action_required';
    if (input.sessionState === 'thinking') return 'thinking';
    if (input.pendingCount > 0) return 'pending';
    if (input.hasUnreadMessages) return 'unread';
    return 'quiet';
}

export function resolveSessionListSecondaryLineMode(params: Readonly<{
    groupKind?: 'active' | 'date' | 'project' | 'pinned' | 'shared' | null;
}>): SessionListSecondaryLineMode {
    if (params.groupKind === 'date') {
        return 'path';
    }
    return 'status';
}
