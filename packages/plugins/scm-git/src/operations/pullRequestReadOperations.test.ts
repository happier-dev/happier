import { describe, expect, it, vi } from 'vitest';

import type {
    ScmHostingProviderRef,
    ScmPullRequestSummary,
    ScmWorkingSnapshot,
} from '@happier-dev/protocol';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import type { ScmBackendContext } from '../types.js';
import { createPrStatusCache } from '../hostingProviders/prStatusCache.js';
import { createGitPullRequestReadOperations } from './pullRequestReadOperations.js';

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
    title: 'Ship SCM PR read cache',
    url: 'https://github.com/happier-dev/happier/pull/42',
    baseBranch: 'main',
    headBranch: 'feature/pr-cache',
    state: 'open',
};

const context: ScmBackendContext = {
    cwd: '/repo',
    projectKey: 'machine-1:/repo',
    detection: {
        isRepo: true,
        rootPath: '/repo',
        mode: '.git',
    },
};

function createSnapshot(): ScmWorkingSnapshot {
    return {
        projectKey: context.projectKey,
        fetchedAt: 1000,
        repo: {
            isRepo: true,
            rootPath: '/repo',
            backendId: 'git',
            mode: '.git',
            worktrees: [],
            remotes: [],
        },
        capabilities: {
            capabilityScope: 'local-backend',
            readStatus: true,
            readDiffFile: true,
            readDiffCommit: true,
            readLog: true,
            writeInclude: true,
            writeExclude: true,
            writeCommit: true,
            writeCommitPathSelection: true,
            writeCommitLineSelection: true,
            writeBackout: true,
            writeRemoteFetch: true,
            writeRemotePull: true,
            writeRemotePush: true,
            worktreeCreate: true,
            changeSetModel: 'index',
            supportedDiffAreas: ['included', 'pending', 'both'],
        },
        branch: {
            head: 'feature/pr-cache',
            upstream: 'origin/main',
            ahead: 1,
            behind: 0,
            detached: false,
        },
        hostingProvider: provider,
        pullRequestStatus: null,
        hasConflicts: false,
        entries: [],
        totals: {
            includedFiles: 0,
            pendingFiles: 0,
            untrackedFiles: 0,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 0,
            pendingRemoved: 0,
        },
    };
}

function createRegistry(adapter: Readonly<Record<string, unknown>>) {
    return {
        getAdapter(id: string) {
            return id === provider.id ? adapter : undefined;
        },
        buildCompareUrl() {
            return {
                kind: 'resolved' as const,
                url: 'https://github.com/happier-dev/happier/compare/main...feature/pr-cache',
            };
        },
    };
}

describe('git pull request read operations', () => {
    it('lists PRs through adapter-owned hooks and reuses the bounded cache for the same branch context', async () => {
        const cache = createPrStatusCache({ now: () => 1000 });
        const listPullRequests = vi.fn(async () => [pullRequest]);
        const operations = createGitPullRequestReadOperations({
            cache,
            registry: createRegistry({
                getPullRequestAuthProfileKey: () => 'profile-a',
                listPullRequests,
            }),
            readSnapshot: async () => createSnapshot(),
            now: () => 1000,
        });

        const first = await operations.list({
            context,
            request: {
                cwd: '/repo',
                base: 'main',
                head: 'feature/pr-cache',
                state: 'open',
            },
        });
        const second = await operations.list({
            context,
            request: {
                cwd: '/repo',
                base: 'main',
                head: 'feature/pr-cache',
                state: 'open',
            },
        });

        expect(first).toMatchObject({ success: true, pullRequests: [pullRequest] });
        expect(second).toMatchObject({ success: true, pullRequests: [pullRequest] });
        expect(listPullRequests).toHaveBeenCalledTimes(1);
    });

    it('passes provider-neutral runtime services to adapter-owned PR hooks', async () => {
        let observedRuntimeServices: unknown = null;
        const operations = createGitPullRequestReadOperations({
            cache: createPrStatusCache({ now: () => 1000 }),
            registry: createRegistry({
                listPullRequests: async (input: Readonly<{ runtimeServices?: unknown }>) => {
                    observedRuntimeServices = input.runtimeServices ?? null;
                    return [pullRequest];
                },
            }),
            readSnapshot: async () => createSnapshot(),
            now: () => 1000,
        });

        const response = await operations.list({
            context,
            request: {
                cwd: '/repo',
                base: 'main',
                head: 'feature/pr-cache',
                state: 'open',
            },
        });

        expect(response.success).toBe(true);
        expect(observedRuntimeServices).toEqual({
            resolveScmHostingBasicAuthMaterialization: expect.any(Function),
            resolveScmHostingTokenMaterialization: expect.any(Function),
            resolveInstallableCommand: expect.any(Function),
            runCommand: expect.any(Function),
        });
    });

    it('stores freshly resolved PR list results under the current auth profile key', async () => {
        const cache = createPrStatusCache({ now: () => 1000 });
        let currentAuthProfileKey: string | null = null;
        const operations = createGitPullRequestReadOperations({
            cache,
            registry: createRegistry({
                getPullRequestAuthProfileKey: () => currentAuthProfileKey,
                listPullRequests: async () => {
                    currentAuthProfileKey = 'github:work';
                    return [pullRequest];
                },
            }),
            readSnapshot: async () => createSnapshot(),
            now: () => 1000,
        });

        await expect(operations.list({
            context,
            request: {
                cwd: '/repo',
                base: 'main',
                head: 'feature/pr-cache',
                state: 'open',
            },
        })).resolves.toMatchObject({ success: true });

        expect(cache.getFresh({
            workspaceKey: context.projectKey,
            repoRootPath: '/repo',
            provider,
            baseBranch: 'main',
            headBranch: 'feature/pr-cache',
            state: 'open',
            authProfileKey: 'github:work',
        })).toMatchObject({
            kind: 'success',
            pullRequests: [pullRequest],
        });
        expect(cache.getFresh({
            workspaceKey: context.projectKey,
            repoRootPath: '/repo',
            provider,
            baseBranch: 'main',
            headBranch: 'feature/pr-cache',
            state: 'open',
        })).toBeNull();
    });

    it('prepares no-auth compose actions from compare URLs without mutating provider state', async () => {
        const listPullRequests = vi.fn(async () => [pullRequest]);
        const operations = createGitPullRequestReadOperations({
            cache: createPrStatusCache({ now: () => 1000 }),
            registry: createRegistry({ listPullRequests }),
            readSnapshot: async () => createSnapshot(),
            now: () => 1000,
        });

        const response = await operations.openCompose({
            context,
            request: {
                cwd: '/repo',
                base: 'main',
                head: 'feature/pr-cache',
            },
        });

        expect(response).toMatchObject({
            success: true,
            composeUrl: 'https://github.com/happier-dev/happier/compare/main...feature/pr-cache',
            nextAction: {
                kind: 'openUrl',
                purpose: 'compose',
                url: 'https://github.com/happier-dev/happier/compare/main...feature/pr-cache',
                allowedBaseUrl: 'https://github.com',
                urlSafety: { allowedSchemes: ['https:'] },
            },
        });
        expect(listPullRequests).not.toHaveBeenCalled();
    });

    it('returns deterministic unsupported errors when no adapter read hook exists', async () => {
        const operations = createGitPullRequestReadOperations({
            cache: createPrStatusCache({ now: () => 1000 }),
            registry: createRegistry({}),
            readSnapshot: async () => createSnapshot(),
            now: () => 1000,
        });

        const response = await operations.list({
            context,
            request: {
                cwd: '/repo',
                base: 'main',
                head: 'feature/pr-cache',
                state: 'open',
            },
        });

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED);
    });

    it('does not resolve explicit numeric references from the current head list when get hook is missing', async () => {
        const operations = createGitPullRequestReadOperations({
            cache: createPrStatusCache({ now: () => 1000 }),
            registry: createRegistry({
                listPullRequests: async () => [pullRequest],
            }),
            readSnapshot: async () => createSnapshot(),
            now: () => 1000,
        });

        const response = await operations.get({
            context,
            request: {
                cwd: '/repo',
                prReference: { number: 404 },
            },
        });

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED);
    });

    it('does not resolve explicit URL references from the current head list when get hook is missing', async () => {
        const operations = createGitPullRequestReadOperations({
            cache: createPrStatusCache({ now: () => 1000 }),
            registry: createRegistry({
                listPullRequests: async () => [pullRequest],
            }),
            readSnapshot: async () => createSnapshot(),
            now: () => 1000,
        });

        const response = await operations.get({
            context,
            request: {
                cwd: '/repo',
                prReference: { url: 'https://github.com/happier-dev/happier/pull/404' },
            },
        });

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED);
    });
});
