import type { SessionState } from '@/utils/sessions/sessionUtils';
import { deriveSessionAttentionState } from '../attention/deriveSessionAttentionState';
import type { PrimaryTurnStatusV1, SessionRuntimeIssueV1, SessionRuntimeActivityState } from '@happier-dev/protocol';
import { hasUnseenSessionTurnCompletion, isSessionListReadyForReview } from './sessionListReadyForReview';
import { resolveSessionListBackgroundWorkAttention, type SessionListBackgroundWorkAttentionMode } from './sessionListBackgroundWorkAttention';

export type SessionListSecondaryLineMode = 'status' | 'path';
export type SessionListAttentionState =
    | 'quiet'
    | 'unread'
    | 'pending'
    | 'ready'
    | 'failed'
    | 'thinking'
    | 'permission_required'
    | 'action_required';

export function resolveSessionListUpdatedAt(params: Readonly<{
    sessionCreatedAt: number | null | undefined;
    sessionUpdatedAt: number | null | undefined;
}>): number {
    return typeof params.sessionUpdatedAt === 'number'
        && Number.isFinite(params.sessionUpdatedAt)
        && params.sessionUpdatedAt > 0
        ? params.sessionUpdatedAt
        : typeof params.sessionCreatedAt === 'number'
            && Number.isFinite(params.sessionCreatedAt)
            && params.sessionCreatedAt > 0
            ? params.sessionCreatedAt
            : 0;
}

export function deriveSessionListMeaningfulActivityAt(params: Readonly<{
    sessionCreatedAt: number | null | undefined;
    sessionMeaningfulActivityAt?: number | null | undefined;
    latestCommittedMessageCreatedAt: number | null | undefined;
    latestThinkingActivityAt: number | null | undefined;
    latestPendingMessageCreatedAt: number | null | undefined;
}>): number | null {
    const meaningfulCandidates = [
        params.sessionMeaningfulActivityAt,
        params.latestCommittedMessageCreatedAt,
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
    pendingBlockedCount?: number;
    sessionState: SessionState;
    latestTurnStatus?: PrimaryTurnStatusV1 | null;
    lastRuntimeIssue?: SessionRuntimeIssueV1 | null;
    seq?: number | null;
    meaningfulActivityAt?: number | null;
    latestTurnStatusObservedAt?: number | null;
    latestReadyEventSeq?: number | null;
    latestReadyEventAt?: number | null;
    lastViewedSessionSeq?: number | null;
    backgroundWorkAttentionMode?: SessionListBackgroundWorkAttentionMode;
    runtimeActivityState?: SessionRuntimeActivityState | null;
    runtimeActivityActiveCount?: number | null;
}>): SessionListAttentionState {
    const sessionAttention = deriveSessionAttentionState({
        latestTurnStatus: input.latestTurnStatus,
        lastRuntimeIssue: input.lastRuntimeIssue,
        isRunning: input.sessionState === 'thinking' || input.sessionState === 'resuming',
    });
    if (input.sessionState === 'action_required') return 'action_required';
    if (input.sessionState === 'permission_required') return 'permission_required';
    if ((input.pendingBlockedCount ?? 0) > 0) return 'action_required';
    // Legacy list/session internals call active turn work "thinking"; row presentation maps this to product "working".
    if (sessionAttention === 'running') return 'thinking';
    if (sessionAttention === 'failed') return 'failed';
    const unseenCompletion = hasUnseenSessionTurnCompletion(input);
    const backgroundAttention = resolveSessionListBackgroundWorkAttention({
        backgroundActive: input.sessionState === 'background_active',
        hasUnreadMessages: input.hasUnreadMessages || unseenCompletion,
        mode: input.backgroundWorkAttentionMode,
    });
    if (backgroundAttention !== null) return backgroundAttention.attentionState;
    if (isSessionListReadyForReview(input)) return 'ready';
    if (input.pendingCount > 0) return 'pending';
    if (input.hasUnreadMessages || unseenCompletion) return 'unread';
    return 'quiet';
}

export function resolveSessionListSecondaryLineMode(params: Readonly<{
    groupKind?: 'active' | 'date' | 'project' | 'pinned' | 'attention' | 'working' | 'shared' | 'folder' | null;
}>): SessionListSecondaryLineMode {
    if (params.groupKind === 'date') {
        return 'path';
    }
    return 'status';
}
