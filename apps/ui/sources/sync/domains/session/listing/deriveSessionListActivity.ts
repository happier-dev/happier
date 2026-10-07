import { SessionAwarenessOperationalPrimaryV1Schema, type SessionAwarenessOperationalPrimaryV1 } from '@happier-dev/protocol/sessions/awareness/projectionV1';
import type { SessionPersonalAttentionReasonV1 } from '@happier-dev/protocol/sessions/personal/attention';

export type SessionListSecondaryLineMode = 'status' | 'path';
export type SessionListAttentionState =
    | 'quiet'
    | 'failed'
    | 'ready'
    | 'attention'
    /** Somebody addressed this viewer by name; unread content with a named author. */
    | 'mentioned'
    | 'unread'
    | 'pending'
    | 'thinking'
    | 'permission_required'
    | 'action_required';

/** One shared translation from Protocol personal reasons into UI presentation vocabulary. */
export function presentSessionPersonalAttentionReason(
    reason: SessionPersonalAttentionReasonV1 | null,
): SessionListAttentionState {
    switch (reason) {
        case 'failed': return 'failed';
        case 'permission_required': return 'permission_required';
        case 'user_action_required':
        case 'pending_blocked': return 'action_required';
        case 'ready_after_read': return 'ready';
        // A mention is unread content somebody pointed AT this viewer. Flattening
        // it onto plain unread cost the row the only fact that distinguishes
        // "there is more here" from "somebody asked you".
        case 'mentioned': return 'mentioned';
        case 'unread':
        case 'unread_discussion': return 'unread';
        case 'manual':
        case 'reminder_due': return 'attention';
        case null: return 'quiet';
    }
}

/**
 * The list's one recency fact.
 *
 * Only committed transcript evidence, queued human input, the session-level
 * meaningful-activity fact and creation count. Transient thinking is operational
 * presentation, so it deliberately has no input here and cannot make a streaming row
 * climb the timeline on every heartbeat.
 */
export function deriveSessionListMeaningfulActivityAt(params: Readonly<{
    sessionMeaningfulActivityAt?: number | null | undefined;
    sessionCreatedAt: number | null | undefined;
    latestCommittedMessageCreatedAt: number | null | undefined;
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

/** UI vocabulary only; operational precedence is decided in Protocol. */
export function mapSessionAwarenessToListAttentionState(
    primary: SessionAwarenessOperationalPrimaryV1,
): SessionListAttentionState {
    switch (primary) {
        case 'none': return 'quiet';
        case 'pending_input': return 'pending';
        case 'working': return 'thinking';
        default: return primary;
    }
}

/**
 * The one place 09A's operational state and 09B's viewer-unread fact are composed into the
 * list's presentation vocabulary.
 *
 * Both owners decide their own facts first; this only chooses which of the two a single row of
 * space shows. Unread is deliberately the weakest input — it surfaces a session nothing else has
 * to say about, and never hides a session that is failing, blocked or working.
 */
export function resolveSessionListAttentionState(input: Readonly<{
    operational: SessionAwarenessOperationalPrimaryV1;
    hasUnreadMessages: boolean;
    /**
     * 09B's primary personal reason, so an unread row that is unread BECAUSE
     * somebody addressed this viewer keeps that fact instead of being flattened
     * onto plain unread. Absent on pre-viewer rows, which stay `unread`.
     */
    personalAttentionReason?: SessionPersonalAttentionReasonV1 | null;
}>): SessionListAttentionState {
    const operational = mapSessionAwarenessToListAttentionState(input.operational);
    if (operational !== 'quiet' || !input.hasUnreadMessages) return operational;
    return input.personalAttentionReason === 'mentioned' ? 'mentioned' : 'unread';
}

/**
 * Sort rank for the states above, derived from the canonical operational ladder rather than
 * restated.
 *
 * A hand-written switch here is how Activity ended up ranking permission above action while
 * Protocol ranked them the other way: presentation may choose emphasis and wording, but it may
 * not reorder semantic states (AWI-12). Deriving the table from the enum's declaration order
 * makes that divergence unrepresentable.
 */
const SESSION_LIST_ATTENTION_RANK: Readonly<Record<SessionListAttentionState, number>> = (() => {
    const ordered: SessionListAttentionState[] = SessionAwarenessOperationalPrimaryV1Schema.options
        .map(mapSessionAwarenessToListAttentionState);
    // 09B's personal states have no operational rank of their own. A generic reason such as a
    // due reminder is stronger than a mention, a mention is stronger than plain unread, and all
    // three outrank a session with nothing to report.
    ordered.splice(ordered.indexOf('quiet'), 0, 'attention', 'mentioned', 'unread');
    const rank = {} as Record<SessionListAttentionState, number>;
    ordered.forEach((state, index) => {
        rank[state] = ordered.length - index;
    });
    rank.quiet = 0;
    return Object.freeze(rank);
})();

export function resolveSessionListAttentionRank(state: SessionListAttentionState): number {
    return SESSION_LIST_ATTENTION_RANK[state];
}

/** The rank of the most alerting state, for consumers that need a normalized 0–1 scale. */
export const MAX_SESSION_LIST_ATTENTION_RANK = SESSION_LIST_ATTENTION_RANK.failed;

/**
 * Whether a state deserves an interruptive surface (Live Activity urgent template, high-priority
 * push). Failure is the highest operational state there is, so anything that ranks at or above
 * "someone must act" qualifies — an explicit allow-list silently dropped `failed`.
 */
export function isUrgentSessionListAttentionState(state: SessionListAttentionState): boolean {
    const actionableFloor = Math.min(
        resolveSessionListAttentionRank('permission_required'),
        resolveSessionListAttentionRank('action_required'),
    );
    return resolveSessionListAttentionRank(state)
        >= actionableFloor;
}

export function resolveSessionListSecondaryLineMode(params: Readonly<{
    groupKind?: 'active' | 'date' | 'project' | 'pinned' | 'loading' | 'folder' | 'attention' | 'working' | null;
}>): SessionListSecondaryLineMode {
    if (params.groupKind === 'date') {
        return 'path';
    }
    return 'status';
}
