import { describe, expect, it } from 'vitest';

describe('pull request reference parsing', () => {
    it('extracts GitHub pull request and GitLab merge request numbers from URLs', async () => {
        const mod = await import('./pullRequestReference');

        expect(mod.parsePullRequestNumberFromUrl('https://github.com/happier-dev/happier/pull/51')).toBe(51);
        expect(mod.parsePullRequestNumberFromUrl('https://gitlab.com/happier-dev/mobile/app/-/merge_requests/17')).toBe(17);
    });

    it('extracts numbers from checkout commands copied from provider CLIs', async () => {
        const mod = await import('./pullRequestReference');

        expect(mod.parsePullRequestNumberFromCheckoutCommand('gh pr checkout 51')).toBe(51);
        expect(mod.parsePullRequestNumberFromCheckoutCommand('glab mr checkout 17')).toBe(17);
    });
});
