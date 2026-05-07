import { describe, expect, it } from 'vitest';

describe('pullRequestReferenceInput', () => {
    it('parses numeric, provider URL, and provider CLI checkout references', async () => {
        const mod = await import('./pullRequestReferenceInput');

        expect(mod.parsePullRequestReferenceInput('42')).toEqual({ number: 42 });
        expect(mod.parsePullRequestReferenceInput('#42')).toEqual({ number: 42 });
        expect(mod.parsePullRequestReferenceInput('https://github.com/happier/dev/pull/42')).toEqual({
            url: 'https://github.com/happier/dev/pull/42',
        });
        expect(mod.parsePullRequestReferenceInput('https://gitlab.com/happier/dev/-/merge_requests/17')).toEqual({
            url: 'https://gitlab.com/happier/dev/-/merge_requests/17',
        });
        expect(mod.parsePullRequestReferenceInput('gh pr checkout 42')).toEqual({ number: 42 });
        expect(mod.parsePullRequestReferenceInput('glab mr checkout 17')).toEqual({ number: 17 });
    });

    it('parses branch references through the protocol headBranch variant', async () => {
        const mod = await import('./pullRequestReferenceInput');

        expect(mod.parsePullRequestReferenceInput('feature/not-a-reference')).toEqual({
            headBranch: 'feature/not-a-reference',
        });
    });

    it('rejects unrelated http urls', async () => {
        const mod = await import('./pullRequestReferenceInput');

        expect(mod.parsePullRequestReferenceInput('https://example.com/not-a-pull-request')).toBeNull();
    });
});
