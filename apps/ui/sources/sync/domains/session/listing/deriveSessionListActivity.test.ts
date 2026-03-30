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

    it('uses the latest thinking activity when it is newer than the last committed message', () => {
        const result = deriveSessionListMeaningfulActivityAt({
            sessionCreatedAt: 100,
            latestCommittedMessageCreatedAt: 1_200,
            latestThinkingActivityAt: 1_800,
            latestPendingMessageCreatedAt: null,
        });

        expect(result).toBe(1_800);
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
});
