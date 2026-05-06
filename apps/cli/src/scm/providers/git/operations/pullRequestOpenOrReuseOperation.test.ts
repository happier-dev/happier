import { describe, expect, it, vi } from 'vitest';

import {
    SCM_OPERATION_ERROR_CODES,
    type ScmHostingProviderRef,
    type ScmPullRequestSummary,
    type ScmWorkingSnapshot,
} from '@happier-dev/protocol';

import type { ScmBackendContext } from '../../../types';
import { createPrStatusCache } from '../hostingProviders/prStatusCache';
import { createGitPullRequestOpenOrReuseOperation } from './pullRequestOpenOrReuseOperation';

const provider: ScmHostingProviderRef = {
    id: 'scm.github',
    kind: 'github',
    displayName: 'GitHub',
    baseUrl: 'https://github.com',
    nameWithOwner: 'happier-dev/happier',
    remoteName: 'origin',
    urlSafety: { allowedSchemes: ['https:'] },
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

function createPullRequest(overrides: Partial<ScmPullRequestSummary> = {}): ScmPullRequestSummary {
    return {
        provider,
        number: 42,
        title: 'Open PR',
        url: 'https://github.com/happier-dev/happier/pull/42',
        baseBranch: 'main',
        headBranch: 'feature/scm-pr-6',
        state: 'open',
        ...overrides,
    };
}

function createSnapshot(overrides: Partial<ScmWorkingSnapshot> = {}): ScmWorkingSnapshot {
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
            writeRemotePublish: true,
            writePullRequestCreate: true,
            defaultBranchPushPolicy: 'requires-feature-branch',
            worktreeCreate: true,
            changeSetModel: 'index',
            supportedDiffAreas: ['included', 'pending', 'both'],
        },
        branch: {
            head: 'feature/scm-pr-6',
            upstream: 'origin/feature/scm-pr-6',
            ahead: 0,
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
        ...overrides,
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
                url: 'https://github.com/happier-dev/happier/compare/main...feature/scm-pr-6',
            };
        },
    };
}

describe('git pull request open-or-reuse operation', () => {
    it('creates through the resolved adapter once, then reuses the open PR from cache/list context', async () => {
        const cache = createPrStatusCache({ now: () => 1000 });
        const pullRequest = createPullRequest();
        const listPullRequests = vi.fn()
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([pullRequest]);
        const createPullRequestHook = vi.fn(async () => pullRequest);
        const operation = createGitPullRequestOpenOrReuseOperation({
            cache,
            registry: createRegistry({
                getPullRequestAuthProfileKey: () => 'github:work',
                listPullRequests,
                createPullRequest: createPullRequestHook,
            }),
            readSnapshot: async () => createSnapshot(),
            now: () => 1000,
        });

        const first = await operation.openOrReuse({
            context,
            request: {
                cwd: '/repo',
                base: 'main',
                title: 'Open PR',
            },
        });
        const second = await operation.openOrReuse({
            context,
            request: {
                cwd: '/repo',
                base: 'main',
                title: 'Open PR',
            },
        });

        expect(first).toMatchObject({ success: true, reused: false, pullRequest });
        expect(second).toMatchObject({ success: true, reused: true, pullRequest });
        expect(createPullRequestHook).toHaveBeenCalledTimes(1);
        expect(cache.getFresh({
            workspaceKey: context.projectKey,
            repoRootPath: '/repo',
            provider,
            baseBranch: 'main',
            headBranch: 'feature/scm-pr-6',
            state: 'open',
            authProfileKey: 'github:work',
        })).toMatchObject({ kind: 'success', pullRequests: [pullRequest] });
    });

    it('returns a no-auth compose action when no authenticated write adapter is available', async () => {
        const operation = createGitPullRequestOpenOrReuseOperation({
            cache: createPrStatusCache({ now: () => 1000 }),
            registry: createRegistry({}),
            readSnapshot: async () => createSnapshot(),
            now: () => 1000,
        });

        await expect(operation.openOrReuse({
            context,
            request: {
                cwd: '/repo',
                base: 'main',
                title: 'Open PR',
            },
        })).resolves.toMatchObject({
            success: true,
            pullRequest: null,
            reused: false,
            composeUrl: 'https://github.com/happier-dev/happier/compare/main...feature/scm-pr-6',
            nextAction: {
                kind: 'openUrl',
                purpose: 'compose',
                url: 'https://github.com/happier-dev/happier/compare/main...feature/scm-pr-6',
                allowedBaseUrl: 'https://github.com',
            },
            authState: 'authentication_required',
        });
    });

    it('validates duplicate-create URL hints against branch-head context before reusing', async () => {
        const validPullRequest = createPullRequest();
        const wrongHintPullRequest = createPullRequest({
            number: 99,
            url: 'https://github.com/happier-dev/happier/pull/99',
            headBranch: 'feature/other',
        });
        const duplicateError = Object.assign(
            new Error('A pull request already exists: https://github.com/happier-dev/happier/pull/99'),
            { errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_ALREADY_EXISTS },
        );
        const operation = createGitPullRequestOpenOrReuseOperation({
            cache: createPrStatusCache({ now: () => 1000 }),
            registry: createRegistry({
                listPullRequests: vi.fn()
                    .mockResolvedValueOnce([])
                    .mockResolvedValueOnce([validPullRequest]),
                getPullRequest: vi.fn(async () => wrongHintPullRequest),
                createPullRequest: vi.fn(async () => {
                    throw duplicateError;
                }),
            }),
            readSnapshot: async () => createSnapshot(),
            now: () => 1000,
        });

        await expect(operation.openOrReuse({
            context,
            request: {
                cwd: '/repo',
                base: 'main',
                title: 'Open PR',
            },
        })).resolves.toMatchObject({
            success: true,
            reused: true,
            pullRequest: validPullRequest,
        });
    });

    it('returns model-derived default-branch actions before publishing or creating a PR', async () => {
        const publishActiveBranch = vi.fn();
        const createPullRequest = vi.fn();
        const operation = createGitPullRequestOpenOrReuseOperation({
            cache: createPrStatusCache({ now: () => 1000 }),
            registry: createRegistry({
                createPullRequest,
            }),
            readSnapshot: async () => createSnapshot({
                branch: {
                    head: 'main',
                    upstream: 'origin/main',
                    ahead: 2,
                    behind: 0,
                    detached: false,
                },
            }),
            publishActiveBranch,
            now: () => 1000,
        });

        const response = await operation.openOrReuse({
            context,
            request: {
                cwd: '/repo',
                base: 'main',
                title: 'Open PR',
            },
        });

        expect(response).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            defaultBranchAction: {
                kind: 'create_feature_branch_and_open_pr',
                baseBranch: 'main',
                currentBranch: 'main',
                ahead: 2,
            },
        });
        expect(publishActiveBranch).not.toHaveBeenCalled();
        expect(createPullRequest).not.toHaveBeenCalled();
    });

    it('publishes the active feature branch instead of pushing to an upstream base branch', async () => {
        const publishActiveBranch = vi.fn(async () => ({ success: true as const }));
        const pullRequest = createPullRequest();
        const operation = createGitPullRequestOpenOrReuseOperation({
            cache: createPrStatusCache({ now: () => 1000 }),
            registry: createRegistry({
                listPullRequests: async () => [],
                createPullRequest: async () => pullRequest,
            }),
            readSnapshot: async () => createSnapshot({
                branch: {
                    head: 'feature/scm-pr-6',
                    upstream: 'origin/main',
                    ahead: 1,
                    behind: 0,
                    detached: false,
                },
            }),
            publishActiveBranch,
            now: () => 1000,
        });

        await expect(operation.openOrReuse({
            context,
            request: {
                cwd: '/repo',
                base: 'main',
                title: 'Open PR',
            },
        })).resolves.toMatchObject({ success: true, pullRequest });
        expect(publishActiveBranch).toHaveBeenCalledWith({
            context,
            request: {
                cwd: '/repo',
            },
            headBranch: 'feature/scm-pr-6',
            reason: 'upstream_points_at_base',
        });
    });
});
