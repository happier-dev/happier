import { describe, expect, it } from 'vitest';

import type { ScmHostingProvider, ScmPullRequestSummary } from '@happier-dev/protocol';

const provider: ScmHostingProvider = {
    kind: 'github',
    name: 'GitHub',
    baseUrl: 'https://github.com',
    nameWithOwner: 'happier-dev/happier',
    remoteName: 'origin',
};

const pullRequest: ScmPullRequestSummary = {
    provider,
    number: 42,
    title: 'Ship PR support',
    url: 'https://github.com/happier-dev/happier/pull/42',
    baseBranch: 'main',
    headBranch: 'feature/pr-support',
    state: 'open',
};

describe('prStatusCache', () => {
    it('returns fresh PR status entries for the same repo/provider/head/auth profile key', async () => {
        const mod = await import('./prStatusCache').catch(() => null);
        expect(mod).not.toBeNull();
        if (!mod) throw new Error('expected PR status cache module');

        const cache = mod.createPrStatusCache({ now: () => 1_000 });
        const key = {
            repoRootPath: '/repo',
            provider,
            head: 'feature/pr-support',
            authProfileKey: 'connected:default',
        };
        cache.setSuccess(key, [pullRequest]);

        expect(cache.getFresh(key)).toEqual({
            kind: 'success',
            pullRequests: [pullRequest],
            fetchedAt: 1_000,
            expiresAt: 61_000,
        });
    });

    it('expires stale entries without returning outdated PR metadata', async () => {
        const mod = await import('./prStatusCache').catch(() => null);
        expect(mod).not.toBeNull();
        if (!mod) throw new Error('expected PR status cache module');

        let now = 1_000;
        const cache = mod.createPrStatusCache({ now: () => now });
        const key = {
            repoRootPath: '/repo',
            provider,
            head: 'feature/pr-support',
            authProfileKey: 'gh-cli',
        };
        cache.setSuccess(key, [pullRequest]);
        now = 61_001;

        expect(cache.getFresh(key)).toBeNull();
    });
});
