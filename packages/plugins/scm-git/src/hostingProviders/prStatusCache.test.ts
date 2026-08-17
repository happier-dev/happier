import { describe, expect, it } from 'vitest';

import type {
  ScmHostingProviderRef } from '@happier-dev/plugin-sdk/scm/hosting';
import type {
  ScmPullRequestSummary,
} from '@happier-dev/plugin-sdk/scm';

import { createPrStatusCache } from './prStatusCache.js';

const provider: ScmHostingProviderRef = {
    id: 'scm.github',
    kind: 'github',
    displayName: 'GitHub',
    baseUrl: 'https://github.com',
    nameWithOwner: 'happier-dev/happier',
    remoteName: 'origin',
    urlSafety: { allowedSchemes: ['https:'] },
};

const pullRequest: ScmPullRequestSummary = {
    provider,
    number: 42,
    title: 'Ship SCM PR cache',
    url: 'https://github.com/happier-dev/happier/pull/42',
    baseBranch: 'main',
    headBranch: 'feature/pr-cache',
    state: 'open',
};

function cacheKey(authProfileKey: string) {
    return {
        workspaceKey: 'machine-1:/repo',
        repoRootPath: '/repo',
        provider,
        baseBranch: 'main',
        headBranch: 'feature/pr-cache',
        state: 'open' as const,
        authProfileKey,
    };
}

describe('PR status cache', () => {
    it('keeps authenticated entries isolated while allowing any-profile stale-while-revalidate reads', () => {
        let now = 1000;
        const cache = createPrStatusCache({
            now: () => now,
            config: {
                successTtlMs: 100,
                authErrorTtlMs: 50,
                notFoundErrorTtlMs: 50,
                networkErrorTtlMs: 25,
                maxEntries: 10,
            },
        });

        cache.setSuccess({
            key: cacheKey('profile-a'),
            pullRequests: [pullRequest],
        });

        expect(cache.getFresh(cacheKey('profile-b'))).toBeNull();
        expect(cache.getFreshForAnyAuthProfile({
            ...cacheKey('profile-b'),
            authProfileKey: undefined,
        })).toMatchObject({
            kind: 'success',
            pullRequests: [pullRequest],
        });

        now = 1101;
        expect(cache.getFresh(cacheKey('profile-a'))).toBeNull();
        expect(cache.getFreshForAnyAuthProfile({
            ...cacheKey('profile-a'),
            authProfileKey: undefined,
        })).toBeNull();
    });

    it('bounds entries and invalidates repository branch contexts after status-changing operations', () => {
        const cache = createPrStatusCache({
            now: () => 2000,
            config: {
                successTtlMs: 1000,
                authErrorTtlMs: 1000,
                notFoundErrorTtlMs: 1000,
                networkErrorTtlMs: 1000,
                maxEntries: 1,
            },
        });

        cache.setSuccess({
            key: cacheKey('profile-a'),
            pullRequests: [pullRequest],
        });
        cache.setError({
            key: {
                ...cacheKey('profile-b'),
                headBranch: 'feature/other',
            },
            error: 'Authentication required',
            errorCode: 'REMOTE_AUTH_REQUIRED',
            errorKind: 'auth',
        });

        expect(cache.getFresh(cacheKey('profile-a'))).toBeNull();
        expect(cache.getFresh({
            ...cacheKey('profile-b'),
            headBranch: 'feature/other',
        })).toMatchObject({
            kind: 'error',
            errorCode: 'REMOTE_AUTH_REQUIRED',
        });

        cache.invalidate({
            repoRootPath: '/repo',
            headBranch: 'feature/other',
        });

        expect(cache.getFresh({
            ...cacheKey('profile-b'),
            headBranch: 'feature/other',
        })).toBeNull();
    });
});
