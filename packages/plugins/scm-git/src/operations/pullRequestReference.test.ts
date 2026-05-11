import { describe, expect, it } from 'vitest';

import { parsePullRequestReference } from './pullRequestReference.js';

describe('pull request reference parser', () => {
    it.each([
        ['42', { number: 42 }],
        ['#42', { number: 42 }],
        ['https://github.com/happier-dev/happier/pull/42', { url: 'https://github.com/happier-dev/happier/pull/42', number: 42 }],
        ['https://gitlab.com/happier-dev/happier/-/merge_requests/42', { url: 'https://gitlab.com/happier-dev/happier/-/merge_requests/42', number: 42 }],
        ['gh pr checkout 42', { number: 42 }],
        ['glab mr checkout 42', { number: 42 }],
    ])('normalizes %s without executing commands', (raw, expected) => {
        expect(parsePullRequestReference(raw)).toMatchObject({
            ok: true,
            reference: expected,
        });
    });

    it('keeps non-command text as a head branch reference', () => {
        expect(parsePullRequestReference('feature/scm-pr-7')).toEqual({
            ok: true,
            reference: { headBranch: 'feature/scm-pr-7' },
        });
    });

    it('rejects empty references', () => {
        expect(parsePullRequestReference('   ')).toMatchObject({
            ok: false,
        });
    });

    it('rejects unsafe head branch fallback references', () => {
        expect(parsePullRequestReference('feature\n--upload-pack=evil')).toMatchObject({
            ok: false,
        });
    });
});
