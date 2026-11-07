import { describe, expect, it } from 'vitest';

import { excludeGuardianReviewSessions, isGuardianReviewSession } from './guardianReviewSessions';

function sessionTitled(id: string, title: string | null, extra: Record<string, unknown> = {}) {
    return { id, metadata: title === null ? { path: '/work/project', host: 'h' } : { path: '/work/project', host: 'h', summary: { text: title }, ...extra } } as never;
}

describe('guardianReviewSessions', () => {
    it('recognises Codex Guardian approval reviews by their exact title', () => {
        expect(isGuardianReviewSession(sessionTitled('a', 'Guardian review'))).toBe(true);
        expect(isGuardianReviewSession(sessionTitled('c', null, {}))).toBe(false);
    });

    it('keeps everything else, including titles that only resemble or mention the phrase', () => {
        expect(isGuardianReviewSession(sessionTitled('a', 'Marco Polo'))).toBe(false);
        expect(isGuardianReviewSession(sessionTitled('b', 'Guardian review of the pnpm bootstrap fix'))).toBe(false);
        expect(isGuardianReviewSession(sessionTitled('c', 'Review the Guardian rollout'))).toBe(false);
        expect(isGuardianReviewSession(sessionTitled('d', 'guardian review'))).toBe(false);
        expect(isGuardianReviewSession(sessionTitled('e', 'Guardian Review'))).toBe(false);
    });

    it('uses the explicit name when there is no summary text', () => {
        const named = { id: 'n', metadata: { path: '/p', host: 'h', name: 'Guardian review' } } as never;
        expect(isGuardianReviewSession(named)).toBe(true);
    });

    it('filters only when asked to and preserves order and identity of the kept sessions', () => {
        const keepA = sessionTitled('1', 'Marco Polo');
        const hide = sessionTitled('2', 'Guardian review');
        const keepB = sessionTitled('3', 'Investigate jammed Happier session');
        const all = [keepA, hide, keepB];

        const filtered = excludeGuardianReviewSessions(all, true);
        expect(filtered).toEqual([keepA, keepB]);
        expect(filtered[0]).toBe(keepA);
        expect(excludeGuardianReviewSessions(all, false)).toBe(all);
    });
});
