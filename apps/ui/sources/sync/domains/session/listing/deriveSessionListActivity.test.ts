import { describe, expect, it } from 'vitest';

import {
    deriveSessionListAttentionState,
    deriveSessionListMeaningfulActivityAt,
    resolveSessionListSecondaryLineMode,
} from './deriveSessionListActivity';
import type { PrimaryTurnStatusV1, SessionRuntimeIssueV1 } from '@happier-dev/protocol';

const runtimeIssue: SessionRuntimeIssueV1 = {
    v: 1,
    scope: 'primary_session',
    status: 'failed',
    code: 'auth_error',
    source: 'auth_error',
    occurredAt: 123,
    sanitizedPreview: 'Authentication failed',
};

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

    it('ignores live thinking heartbeats so session-list recency stays stable during streaming', () => {
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
    function input(overrides: Partial<Parameters<typeof deriveSessionListAttentionState>[0]> & {
        latestTurnStatus?: PrimaryTurnStatusV1 | null;
        lastRuntimeIssue?: SessionRuntimeIssueV1 | null;
        latestReadyEventSeq?: number | null;
        latestReadyEventAt?: number | null;
        lastViewedSessionSeq?: number | null;
        latestTurnStatusObservedAt?: number | null;
        meaningfulActivityAt?: number | null;
    } = {}) {
        return {
            hasUnreadMessages: false,
            pendingCount: 0,
            pendingBlockedCount: 0,
            sessionState: 'waiting' as const,
            ...overrides,
        };
    }

    it('marks unread sessions as needing emphasis even when otherwise quiet', () => {
        expect(deriveSessionListAttentionState(input({ hasUnreadMessages: true }))).toBe('unread');
    });

    it('keeps background work working independently of reading a completed reply', () => {
        const background = input({
            sessionState: 'background_active',
            latestTurnStatus: 'completed',
            latestReadyEventSeq: 4,
            lastViewedSessionSeq: 1,
            hasUnreadMessages: true,
        });
        expect(deriveSessionListAttentionState(background)).toBe('thinking');
        expect(deriveSessionListAttentionState({ ...background, lastViewedSessionSeq: 4, hasUnreadMessages: false })).toBe('thinking');
        expect(deriveSessionListAttentionState({ ...background, backgroundWorkAttentionMode: 'showUnread' })).toBe('unread');
        expect(deriveSessionListAttentionState({ ...background, backgroundWorkAttentionMode: 'keepWorkingUnread' })).toBe('unread');
        expect(deriveSessionListAttentionState({ ...background, sessionState: 'waiting' })).toBe('ready');
        expect(deriveSessionListAttentionState({ ...background, pendingBlockedCount: 1 })).toBe('action_required');
        expect(deriveSessionListAttentionState({ ...background, sessionState: 'permission_required' })).toBe('permission_required');
    });

    it('preserves explicit permission-required attention over generic unread state', () => {
        expect(deriveSessionListAttentionState(input({
            hasUnreadMessages: true,
            sessionState: 'permission_required',
        }))).toBe('permission_required');
    });

    it('treats pending queue activity as an attention state', () => {
        expect(deriveSessionListAttentionState(input({ pendingCount: 2 }))).toBe('pending');
    });

    it('treats blocked pending delivery as action-required attention', () => {
        expect(deriveSessionListAttentionState(input({
            pendingCount: 2,
            pendingBlockedCount: 1,
        }))).toBe('action_required');
    });

    it('treats resuming sessions as active attention before generic pending activity', () => {
        expect(deriveSessionListAttentionState(input({
            pendingCount: 2,
            sessionState: 'resuming',
        }))).toBe('thinking');
    });

    it('keeps action and permission blockers visible over failed primary turns', () => {
        expect(deriveSessionListAttentionState(input({
            latestTurnStatus: 'failed',
            lastRuntimeIssue: runtimeIssue,
            sessionState: 'action_required',
            pendingCount: 2,
            hasUnreadMessages: true,
            latestReadyEventSeq: 10,
            lastViewedSessionSeq: 1,
        }))).toBe('action_required');

        expect(deriveSessionListAttentionState(input({
            latestTurnStatus: 'failed',
            lastRuntimeIssue: runtimeIssue,
            sessionState: 'permission_required',
            pendingCount: 2,
            hasUnreadMessages: true,
            latestReadyEventSeq: 10,
            lastViewedSessionSeq: 1,
        }))).toBe('permission_required');
    });

    it('prioritizes failed primary turns over non-blocking attention sources', () => {
        expect(deriveSessionListAttentionState(input({
            latestTurnStatus: 'failed',
            lastRuntimeIssue: runtimeIssue,
            pendingCount: 2,
            hasUnreadMessages: true,
            latestReadyEventSeq: 10,
            lastViewedSessionSeq: 1,
        }))).toBe('failed');
    });

    it('prioritizes action and permission blockers over working and ready', () => {
        expect(deriveSessionListAttentionState(input({
            sessionState: 'action_required',
            latestTurnStatus: 'in_progress',
            latestReadyEventSeq: 10,
            lastViewedSessionSeq: 1,
        }))).toBe('action_required');

        expect(deriveSessionListAttentionState(input({
            sessionState: 'permission_required',
            latestTurnStatus: 'in_progress',
            latestReadyEventSeq: 10,
            lastViewedSessionSeq: 1,
        }))).toBe('permission_required');
    });

    it('prioritizes active turn work over stale ready markers', () => {
        expect(deriveSessionListAttentionState(input({
            sessionState: 'thinking',
            latestReadyEventSeq: 10,
            lastViewedSessionSeq: 1,
        }))).toBe('thinking');
    });

    it('does not keep stale working attention after a completed primary turn projection with no newer activity', () => {
        expect(deriveSessionListAttentionState(input({
            sessionState: 'waiting',
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 1_000,
            meaningfulActivityAt: 500,
            seq: 10,
            latestReadyEventSeq: null,
            lastViewedSessionSeq: 9,
        }))).toBe('ready');
    });

    it('keeps unread attention when activity is clearly newer than the completed primary turn projection', () => {
        expect(deriveSessionListAttentionState(input({
            hasUnreadMessages: true,
            sessionState: 'waiting',
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 1_000,
            meaningfulActivityAt: 3_500,
            seq: 10,
            latestReadyEventSeq: null,
            lastViewedSessionSeq: 9,
        }))).toBe('unread');
    });

    it('keeps failed attention when activity is newer than a failed primary turn projection', () => {
        expect(deriveSessionListAttentionState(input({
            sessionState: 'waiting',
            latestTurnStatus: 'failed',
            lastRuntimeIssue: runtimeIssue,
            latestTurnStatusObservedAt: 1_000,
            meaningfulActivityAt: 1_500,
            seq: 10,
            latestReadyEventSeq: null,
            lastViewedSessionSeq: 9,
        }))).toBe('failed');
    });

    it('does not hide the failed primary projection behind a thinking signal', () => {
        expect(deriveSessionListAttentionState(input({
            sessionState: 'thinking',
            latestTurnStatus: 'failed',
            lastRuntimeIssue: runtimeIssue,
            latestTurnStatusObservedAt: 1_000,
            meaningfulActivityAt: 500,
            seq: 10,
            latestReadyEventSeq: null,
            lastViewedSessionSeq: 9,
        }))).toBe('failed');
    });

    it('does not treat stale in-progress projection as working attention without fresh session status thinking', () => {
        expect(deriveSessionListAttentionState(input({
            sessionState: 'waiting',
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 1_000,
            meaningfulActivityAt: 1_500,
            seq: 10,
            latestReadyEventSeq: null,
            lastViewedSessionSeq: 9,
        }))).toBe('quiet');
    });

    it('marks ready only when the latest ready seq is newer than the read cursor', () => {
        expect(deriveSessionListAttentionState(input({
            hasUnreadMessages: true,
            latestReadyEventSeq: 10,
            lastViewedSessionSeq: 9,
        }))).toBe('ready');

        expect(deriveSessionListAttentionState(input({
            hasUnreadMessages: true,
            latestReadyEventSeq: 10,
            lastViewedSessionSeq: 10,
        }))).toBe('unread');
    });

    it('marks completed turns as ready when the session seq is newer than the read cursor', () => {
        expect(deriveSessionListAttentionState(input({
            hasUnreadMessages: true,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 1_000,
            meaningfulActivityAt: 1_000,
            seq: 10,
            latestReadyEventSeq: null,
            lastViewedSessionSeq: 9,
        }))).toBe('ready');

        expect(deriveSessionListAttentionState(input({
            hasUnreadMessages: true,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 1_000,
            meaningfulActivityAt: 1_000,
            seq: 10,
            latestReadyEventSeq: null,
            lastViewedSessionSeq: 10,
        }))).toBe('unread');
    });

    it('marks completed turns as ready when final activity lands just after the terminal projection', () => {
        expect(deriveSessionListAttentionState(input({
            hasUnreadMessages: true,
            sessionState: 'waiting',
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 1_000,
            meaningfulActivityAt: 1_044,
            seq: 10,
            latestReadyEventSeq: null,
            lastViewedSessionSeq: 9,
        }))).toBe('ready');
    });

    it('does not mark post-terminal work as ready just because later tool events advance the session seq', () => {
        expect(deriveSessionListAttentionState(input({
            hasUnreadMessages: true,
            sessionState: 'waiting',
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 1_000,
            meaningfulActivityAt: 3_500,
            seq: 10,
            latestReadyEventSeq: null,
            lastViewedSessionSeq: 9,
        }))).toBe('unread');
    });

    it('prioritizes ready over pending and pending over generic unread', () => {
        expect(deriveSessionListAttentionState(input({
            pendingCount: 2,
            hasUnreadMessages: true,
            latestReadyEventSeq: 10,
            lastViewedSessionSeq: 1,
        }))).toBe('ready');

        expect(deriveSessionListAttentionState(input({
            pendingCount: 2,
            hasUnreadMessages: true,
        }))).toBe('pending');
    });
});
