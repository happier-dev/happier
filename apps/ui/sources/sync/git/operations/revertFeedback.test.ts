import { describe, expect, it } from 'vitest';

import { buildRevertConfirmBody, shortSha } from './revertFeedback';

describe('revertFeedback', () => {
    it('shortens commit sha for display', () => {
        expect(shortSha('0123456789abcdef')).toBe('01234567');
        expect(shortSha('abcd')).toBe('abcd');
    });

    it('builds revert confirmation text with branch context', () => {
        expect(
            buildRevertConfirmBody({
                commit: '0123456789abcdef',
                branch: 'main',
                detached: false,
                detachedLabel: 'Detached HEAD',
            }),
        ).toContain('creates a new commit');
        expect(
            buildRevertConfirmBody({
                commit: '0123456789abcdef',
                branch: 'main',
                detached: false,
                detachedLabel: 'Detached HEAD',
            }),
        ).toContain('branch main');
    });

    it('falls back to detached label when branch is unavailable', () => {
        expect(
            buildRevertConfirmBody({
                commit: '0123456789abcdef',
                branch: null,
                detached: true,
                detachedLabel: 'Detached HEAD',
            }),
        ).toContain('Detached HEAD');
    });
});
