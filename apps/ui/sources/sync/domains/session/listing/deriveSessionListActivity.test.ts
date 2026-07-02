import { describe, expect, it } from 'vitest';

import {
    deriveSessionListAttentionState,
    deriveSessionListMeaningfulActivityAt,
    resolveSessionListSecondaryLineMode,
} from './deriveSessionListActivity';

describe('deriveSessionListMeaningfulActivityAt', () => {
    it('prefers real transcript activity over session updatedAt churn', () => {
        const result = deriveSessionListMeaningfulActivityAt({
            sessionCreatedAt: 100,
            latestCommittedMessageCreatedAt: 1_200,
            latestThinkingActivityAt: null,
            latestPendingMessageCreatedAt: null,
        });

        expect(result).toBe(1_200);
    });

    it('keeps newer session-level meaningful activity over older committed transcript evidence', () => {
        const result = deriveSessionListMeaningfulActivityAt({
            sessionMeaningfulActivityAt: 2_400,
            sessionCreatedAt: 100,
            latestCommittedMessageCreatedAt: 1_200,
            latestThinkingActivityAt: null,
            latestPendingMessageCreatedAt: null,
        });

        expect(result).toBe(2_400);
    });

    it('ignores thinking heartbeat activity when choosing meaningful activity', () => {
        const result = deriveSessionListMeaningfulActivityAt({
            sessionCreatedAt: 100,
            latestCommittedMessageCreatedAt: 1_200,
            latestThinkingActivityAt: 1_800,
            latestPendingMessageCreatedAt: null,
        });

        expect(result).toBe(1_200);
    });

    it('falls back to the session createdAt when there is no transcript activity', () => {
        const result = deriveSessionListMeaningfulActivityAt({
            sessionCreatedAt: 321,
            latestCommittedMessageCreatedAt: null,
            latestThinkingActivityAt: null,
            latestPendingMessageCreatedAt: null,
        });

        expect(result).toBe(321);
    });
});

describe('resolveSessionListSecondaryLineMode', () => {
    it('uses status mode for project-grouped rows', () => {
        expect(resolveSessionListSecondaryLineMode({ groupKind: 'project' })).toBe('status');
    });

    it('uses path mode for date-grouped rows', () => {
        expect(resolveSessionListSecondaryLineMode({ groupKind: 'date' })).toBe('path');
    });
});

describe('deriveSessionListAttentionState', () => {
    it('marks unread sessions as needing emphasis even when otherwise quiet', () => {
        expect(deriveSessionListAttentionState({
            hasUnreadMessages: true,
            pendingCount: 0,
            sessionState: 'waiting',
        })).toBe('unread');
    });

    it('preserves explicit permission-required attention over generic unread state', () => {
        expect(deriveSessionListAttentionState({
            hasUnreadMessages: true,
            pendingCount: 0,
            sessionState: 'permission_required',
        })).toBe('permission_required');
    });

    it('treats pending queue activity as an attention state', () => {
        expect(deriveSessionListAttentionState({
            hasUnreadMessages: false,
            pendingCount: 2,
            sessionState: 'waiting',
        })).toBe('pending');
    });

    it('treats resuming sessions as active attention before generic pending activity', () => {
        expect(deriveSessionListAttentionState({
            hasUnreadMessages: false,
            pendingCount: 2,
            sessionState: 'resuming',
        })).toBe('thinking');
    });

    it('uses failed attention for failed primary turns without requiring runtime issue audit data', () => {
        expect(deriveSessionListAttentionState({
            hasUnreadMessages: true,
            pendingCount: 2,
            sessionState: 'thinking',
            latestTurnStatus: 'failed',
        })).toBe('failed');
    });

    it('keeps failed attention when only meaningful activity is newer than a failed primary turn projection', () => {
        expect(deriveSessionListAttentionState({
            hasUnreadMessages: true,
            pendingCount: 0,
            sessionState: 'thinking',
            latestTurnStatus: 'failed',
            lastRuntimeIssue: {
                v: 1,
                scope: 'primary_session',
                status: 'failed',
                code: 'provider_status_error',
                source: 'provider_status_error',
                occurredAt: 100,
                sanitizedPreview: 'Provider reported an error',
            },
            latestTurnStatusObservedAt: 1_000,
            meaningfulActivityAt: 1_500,
            seq: 10,
            latestReadyEventSeq: null,
            lastViewedSessionSeq: 9,
        })).toBe('failed');
    });

    it('prioritizes failed primary turns over action-required attention', () => {
        expect(deriveSessionListAttentionState({
            hasUnreadMessages: true,
            pendingCount: 2,
            sessionState: 'action_required',
            latestTurnStatus: 'failed',
        })).toBe('failed');
    });

    it('does not use stale in-progress primary turns as thinking attention', () => {
        expect(deriveSessionListAttentionState({
            hasUnreadMessages: false,
            pendingCount: 0,
            sessionState: 'waiting',
            latestTurnStatus: 'in_progress',
        })).toBe('quiet');
    });

    it('uses fresh in-progress primary turns as thinking attention', () => {
        expect(deriveSessionListAttentionState({
            hasUnreadMessages: false,
            pendingCount: 0,
            sessionState: 'waiting',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 1_000,
            active: true,
            presence: 'online',
            nowMs: 1_100,
        })).toBe('thinking');
    });

    it('uses unread completed primary turns as ready attention', () => {
        expect(deriveSessionListAttentionState({
            hasUnreadMessages: true,
            pendingCount: 0,
            sessionState: 'thinking',
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 1_000,
            meaningfulActivityAt: 1_000,
            seq: 10,
            lastViewedSessionSeq: 9,
        })).toBe('ready');
    });

    it('uses unread attention when only meaningful activity is clearly newer than a completed primary turn projection', () => {
        expect(deriveSessionListAttentionState({
            hasUnreadMessages: true,
            pendingCount: 0,
            sessionState: 'thinking',
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 1_000,
            meaningfulActivityAt: 3_500,
            seq: 10,
            lastViewedSessionSeq: 9,
        })).toBe('unread');
    });

    it('uses ready attention when final activity lands just after the completed primary turn projection', () => {
        expect(deriveSessionListAttentionState({
            hasUnreadMessages: true,
            pendingCount: 0,
            sessionState: 'thinking',
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 1_000,
            meaningfulActivityAt: 1_044,
            seq: 10,
            lastViewedSessionSeq: 9,
        })).toBe('ready');
    });

    it('does not mark post-terminal work as ready just because later tool events advance the session seq', () => {
        expect(deriveSessionListAttentionState({
            hasUnreadMessages: true,
            pendingCount: 0,
            sessionState: 'waiting',
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 1_000,
            meaningfulActivityAt: 3_500,
            seq: 10,
            lastViewedSessionSeq: 9,
        })).toBe('unread');
    });

    it('preserves running attention while a new turn is in progress with a previous audit issue', () => {
        expect(deriveSessionListAttentionState({
            hasUnreadMessages: true,
            pendingCount: 0,
            sessionState: 'thinking',
            latestTurnStatus: 'in_progress',
            lastRuntimeIssue: {
                v: 1,
                scope: 'primary_session',
                status: 'failed',
                code: 'provider_status_error',
                source: 'provider_status_error',
                occurredAt: 100,
                sanitizedPreview: 'Provider reported an error',
            },
        })).toBe('thinking');
    });
});
