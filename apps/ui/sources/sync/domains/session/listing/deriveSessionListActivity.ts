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
    const meaningfulCandidates = [
        params.latestCommittedMessageCreatedAt,
        params.latestThinkingActivityAt,
        params.latestPendingMessageCreatedAt,
        params.sessionCreatedAt,
    ];

    let latest: number | null = null;
    for (const candidate of meaningfulCandidates) {
        if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate <= 0) continue;
        latest = latest == null ? candidate : Math.max(latest, candidate);
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
    groupKind?: 'active' | 'date' | 'project' | 'pinned' | null;
}>): SessionListSecondaryLineMode {
    if (params.groupKind === 'date') {
        return 'path';
    }
    return 'status';
}
