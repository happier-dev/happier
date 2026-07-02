import type { SessionState } from '@/utils/sessions/sessionUtils';
import { deriveSessionRuntimePresentationState } from '@/sync/domains/session/attention/runtimePresentation';
import type { PrimaryTurnStatusV1, SessionRuntimeIssueV1 } from '@happier-dev/protocol';
import { hasActivityClearlyAfterTerminalProjection } from './sessionListTerminalActivity';

export type SessionListSecondaryLineMode = 'status' | 'path';
export type SessionListAttentionState =
    | 'quiet'
    | 'failed'
    | 'ready'
    | 'unread'
    | 'pending'
    | 'thinking'
    | 'permission_required'
    | 'action_required';

export function deriveSessionListMeaningfulActivityAt(params: Readonly<{
    sessionMeaningfulActivityAt?: number | null | undefined;
    sessionCreatedAt: number | null | undefined;
    latestCommittedMessageCreatedAt: number | null | undefined;
    latestThinkingActivityAt: number | null | undefined;
    latestPendingMessageCreatedAt: number | null | undefined;
}>): number | null {
    let latest: number | null = null;

    const include = (value: number | null | undefined) => {
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return;
        latest = latest == null ? value : Math.max(latest, value);
    };

    const sessionMeaningfulActivityAt = params.sessionMeaningfulActivityAt;
    include(sessionMeaningfulActivityAt);
    const committed = params.latestCommittedMessageCreatedAt;
    include(committed);
    const pending = params.latestPendingMessageCreatedAt;
    include(pending);
    const sessionCreatedAt = params.sessionCreatedAt;
    include(sessionCreatedAt);

    return latest;
}

export function deriveSessionListAttentionState(input: Readonly<{
    hasUnreadMessages: boolean;
    pendingCount: number;
    sessionState: SessionState;
    latestTurnStatus?: PrimaryTurnStatusV1 | null;
    lastRuntimeIssue?: SessionRuntimeIssueV1 | null;
    active?: boolean | null;
    activeAt?: number | null;
    presence?: unknown;
    thinking?: boolean | null;
    thinkingAt?: number | null;
    seq?: number | null;
    meaningfulActivityAt?: number | null;
    latestTurnStatusObservedAt?: number | null;
    latestReadyEventSeq?: number | null;
    lastViewedSessionSeq?: number | null;
    pendingRequestObservedAt?: number | null;
    nowMs?: number;
}>): SessionListAttentionState {
    const hasTerminalPrimaryTurnProjection =
        input.latestTurnStatus === 'completed'
        || input.latestTurnStatus === 'cancelled'
        || input.latestTurnStatus === 'failed';
    const runtimePresentation = deriveSessionRuntimePresentationState({
        active: input.active,
        activeAt: input.activeAt,
        presence: input.presence,
        thinking: input.thinking,
        thinkingAt: input.thinkingAt,
        latestTurnStatus: input.latestTurnStatus,
        lastRuntimeIssue: input.lastRuntimeIssue,
        latestTurnStatusObservedAt: input.latestTurnStatusObservedAt,
        meaningfulActivityAt: input.meaningfulActivityAt,
        hasPendingPermissionRequests: input.sessionState === 'permission_required',
        hasPendingUserActionRequests: input.sessionState === 'action_required',
        pendingRequestObservedAt: input.pendingRequestObservedAt,
        nowMs: input.nowMs,
    });
    if (runtimePresentation.attention === 'failed') return 'failed';
    if (input.sessionState === 'action_required') return 'action_required';
    if (input.sessionState === 'permission_required') return 'permission_required';
    if (runtimePresentation.working) return 'thinking';
    if (!hasTerminalPrimaryTurnProjection && input.sessionState === 'resuming') return 'thinking';
    if (!hasTerminalPrimaryTurnProjection && input.sessionState === 'thinking') return 'thinking';
    if (isReadyAfterReadCursor(input)) return 'ready';
    if (input.pendingCount > 0) return 'pending';
    if (input.hasUnreadMessages) return 'unread';
    return 'quiet';
}

function isReadyAfterReadCursor(input: Readonly<{
    latestTurnStatus?: PrimaryTurnStatusV1 | null;
    latestReadyEventSeq?: number | null;
    meaningfulActivityAt?: number | null;
    latestTurnStatusObservedAt?: number | null;
    seq?: number | null;
    lastViewedSessionSeq?: number | null;
}>): boolean {
    const lastViewedSessionSeq = normalizeSeq(input.lastViewedSessionSeq) ?? 0;
    const latestReadyEventSeq = normalizeSeq(input.latestReadyEventSeq);
    if (latestReadyEventSeq != null) {
        return latestReadyEventSeq > lastViewedSessionSeq;
    }
    if (input.latestTurnStatus !== 'completed') {
        return false;
    }
    const latestTurnStatusObservedAt = normalizeSeq(input.latestTurnStatusObservedAt);
    const meaningfulActivityAt = normalizeSeq(input.meaningfulActivityAt);
    if (hasActivityClearlyAfterTerminalProjection(meaningfulActivityAt, latestTurnStatusObservedAt)) {
        return false;
    }
    const sessionSeq = normalizeSeq(input.seq);
    return sessionSeq != null && sessionSeq > lastViewedSessionSeq;
}

function normalizeSeq(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : null;
}

export function resolveSessionListSecondaryLineMode(params: Readonly<{
    groupKind?: 'active' | 'date' | 'project' | 'pinned' | 'shared' | 'folder' | 'attention' | 'working' | null;
}>): SessionListSecondaryLineMode {
    if (params.groupKind === 'date') {
        return 'path';
    }
    return 'status';
}
