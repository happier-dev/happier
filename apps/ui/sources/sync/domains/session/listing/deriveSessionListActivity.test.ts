import { describe, expect, it } from 'vitest';
import { deriveSessionListMeaningfulActivityAt, resolveSessionListSecondaryLineMode } from './deriveSessionListActivity';

describe('deriveSessionListMeaningfulActivityAt', () => {
    it('prefers real transcript activity over session updatedAt churn', () => {
        const result = deriveSessionListMeaningfulActivityAt({
            sessionCreatedAt: 100,
            latestCommittedMessageCreatedAt: 1_200,
            latestPendingMessageCreatedAt: null,
        });

        expect(result).toBe(1_200);
    });

    it('keeps newer session-level meaningful activity over older committed transcript evidence', () => {
        const result = deriveSessionListMeaningfulActivityAt({
            sessionMeaningfulActivityAt: 2_400,
            sessionCreatedAt: 100,
            latestCommittedMessageCreatedAt: 1_200,
            latestPendingMessageCreatedAt: null,
        });

        expect(result).toBe(2_400);
    });

    it('falls back to the session createdAt when there is no transcript activity', () => {
        const result = deriveSessionListMeaningfulActivityAt({
            sessionCreatedAt: 321,
            latestCommittedMessageCreatedAt: null,
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
