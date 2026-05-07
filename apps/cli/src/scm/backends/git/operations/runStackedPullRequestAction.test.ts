import { describe, expect, it } from 'vitest';

import {
    SCM_OPERATION_ERROR_CODES,
    type ScmPullRequestSummary,
    type ScmWorkingSnapshot,
} from '@happier-dev/protocol';

import type { ScmBackendContext } from '../../../types';

const provider = {
    kind: 'github',
    name: 'GitHub',
    baseUrl: 'https://github.com',
    nameWithOwner: 'happier-dev/happier',
    remoteName: 'origin',
} as const;

const pullRequest: ScmPullRequestSummary = {
    provider,
    number: 77,
    title: 'Ship stacked workflow',
    url: 'https://github.com/happier-dev/happier/pull/77',
    baseBranch: 'main',
    headBranch: 'feature/pr-workflow',
    state: 'open',
};

function snapshot(overrides: Partial<ScmWorkingSnapshot> = {}): ScmWorkingSnapshot {
    return {
        projectKey: 'test:/repo',
        fetchedAt: 1_000,
        repo: {
            isRepo: true,
            rootPath: '/repo',
            backendId: 'git',
            mode: '.git',
            worktrees: [],
            remotes: [{
                name: 'origin',
                fetchUrl: 'https://github.com/happier-dev/happier.git',
                pushUrl: 'https://github.com/happier-dev/happier.git',
            }],
        },
        capabilities: {
            readStatus: true,
            readDiffFile: true,
            readDiffCommit: true,
            readLog: true,
            readBranches: true,
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
            readHostingProvider: true,
            readPullRequests: true,
            writePullRequestCreate: true,
            writePullRequestRunStacked: true,
            defaultBranchPushPolicy: 'requires-feature-branch',
            worktreeCreate: true,
            changeSetModel: 'index',
            supportedDiffAreas: ['included', 'pending', 'both'],
        },
        branch: {
            head: 'main',
            upstream: 'origin/main',
            ahead: 0,
            behind: 0,
            detached: false,
        },
        stashCount: 0,
        hostingProvider: provider,
        pullRequest: null,
        hasConflicts: false,
        entries: [],
        totals: {
            includedFiles: 0,
            pendingFiles: 1,
            untrackedFiles: 0,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 1,
            pendingRemoved: 0,
        },
        ...overrides,
    };
}

describe('runStackedPullRequestAction', () => {
    it('creates a feature branch before commit/push/pr when default branch policy requires it', async () => {
        const calls: string[] = [];
        const { createRunStackedPullRequestAction } = await import('./runStackedPullRequestAction');
        const runStacked = createRunStackedPullRequestAction({
            readSnapshot: async () => snapshot(),
            branchCreate: async () => {
                calls.push('branch');
                return { success: true };
            },
            commitCreate: async () => {
                calls.push('commit');
                return { success: true, commitSha: 'abc123' };
            },
            remotePush: async () => {
                calls.push('push');
                return { success: true };
            },
            remotePublish: async () => {
                calls.push('publish');
                return { success: true };
            },
            openOrReuse: async () => {
                calls.push('pr');
                return { success: true, kind: 'opened', pullRequest, reused: false };
            },
            now: () => 1_000,
        });

        const response = await runStacked({
            context: { cwd: '/repo', projectKey: 'test:/repo', detection: { isRepo: true, rootPath: '/repo', mode: '.git' } },
            request: {
                action: 'commitPushPr',
                featureBranch: 'feature/pr-workflow',
                commitMessage: 'Ship stacked workflow',
                base: 'main',
                title: 'Ship stacked workflow',
                body: 'Create branch, commit, push, and PR.',
            },
        });

        expect(response).toMatchObject({
            success: true,
            branch: 'feature/pr-workflow',
            commitSha: 'abc123',
            pullRequest,
        });
        expect(calls).toEqual(['branch', 'commit', 'publish', 'pr']);
        expect(response.success ? response.events.map((event) => event.phase) : []).toEqual([
            undefined,
            'branch',
            'commit',
            'push',
            'pr',
            undefined,
        ]);
    });

    it('rejects default-branch stacked writes without a feature branch before mutating the repo', async () => {
        const calls: string[] = [];
        const { createRunStackedPullRequestAction } = await import('./runStackedPullRequestAction');
        const runStacked = createRunStackedPullRequestAction({
            readSnapshot: async () => snapshot(),
            branchCreate: async () => {
                calls.push('branch');
                return { success: true };
            },
            commitCreate: async () => {
                calls.push('commit');
                return { success: true, commitSha: 'abc123' };
            },
            remotePush: async () => {
                calls.push('push');
                return { success: true };
            },
            remotePublish: async () => {
                calls.push('publish');
                return { success: true };
            },
            openOrReuse: async () => {
                calls.push('pr');
                return { success: true, kind: 'opened', pullRequest, reused: false };
            },
            now: () => 1_000,
        });

        const response = await runStacked({
            context: { cwd: '/repo', projectKey: 'test:/repo', detection: { isRepo: true, rootPath: '/repo', mode: '.git' } },
            request: {
                action: 'commitPushPr',
                commitMessage: 'Ship stacked workflow',
                base: 'main',
                title: 'Ship stacked workflow',
                body: 'Create branch, commit, push, and PR.',
            },
        });

        expect(response.success).toBe(false);
        if (response.success) return;
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.INVALID_REQUEST);
        expect(calls).toEqual([]);
        expect(response).toMatchObject({
            events: [{
                kind: 'action_started',
                message: 'commitPushPr',
            }, {
                kind: 'action_failed',
                message: 'Create or choose a feature branch before running this pull request action.',
            }],
        });
    });

    it('pushes a created feature branch before opening a pull request from default-branch commits', async () => {
        const calls: string[] = [];
        const { createRunStackedPullRequestAction } = await import('./runStackedPullRequestAction');
        const runStacked = createRunStackedPullRequestAction({
            readSnapshot: async () => snapshot({
                branch: {
                    head: 'main',
                    upstream: 'origin/main',
                    ahead: 2,
                    behind: 0,
                    detached: false,
                },
                totals: {
                    includedFiles: 0,
                    pendingFiles: 0,
                    untrackedFiles: 0,
                    includedAdded: 0,
                    includedRemoved: 0,
                    pendingAdded: 0,
                    pendingRemoved: 0,
                },
            }),
            branchCreate: async () => {
                calls.push('branch');
                return { success: true };
            },
            commitCreate: async () => {
                calls.push('commit');
                return { success: true, commitSha: 'abc123' };
            },
            remotePush: async () => {
                calls.push('push');
                return { success: true };
            },
            remotePublish: async () => {
                calls.push('publish');
                return { success: true };
            },
            openOrReuse: async () => {
                calls.push('pr');
                return { success: true, kind: 'opened', pullRequest, reused: false };
            },
            now: () => 1_000,
        });

        const response = await runStacked({
            context: { cwd: '/repo', projectKey: 'test:/repo', detection: { isRepo: true, rootPath: '/repo', mode: '.git' } },
            request: {
                action: 'createPr',
                featureBranch: 'feature/pr-workflow',
                base: 'main',
                title: 'Ship stacked workflow',
                body: 'Create branch, push, and PR.',
            },
        });

        expect(response).toMatchObject({
            success: true,
            branch: 'feature/pr-workflow',
            pullRequest,
        });
        expect(calls).toEqual(['branch', 'publish', 'pr']);
        expect(response.success ? response.events.map((event) => event.phase) : []).toEqual([
            undefined,
            'branch',
            'push',
            'pr',
            undefined,
        ]);
    });

    it('pushes an unpublished feature branch before opening a pull request', async () => {
        const calls: string[] = [];
        const { createRunStackedPullRequestAction } = await import('./runStackedPullRequestAction');
        const runStacked = createRunStackedPullRequestAction({
            readSnapshot: async () => snapshot({
                branch: {
                    head: 'feature/pr-workflow',
                    upstream: null,
                    ahead: 1,
                    behind: 0,
                    detached: false,
                },
                totals: {
                    includedFiles: 0,
                    pendingFiles: 0,
                    untrackedFiles: 0,
                    includedAdded: 0,
                    includedRemoved: 0,
                    pendingAdded: 0,
                    pendingRemoved: 0,
                },
            }),
            branchCreate: async () => {
                calls.push('branch');
                return { success: true };
            },
            commitCreate: async () => {
                calls.push('commit');
                return { success: true, commitSha: 'abc123' };
            },
            remotePush: async () => {
                calls.push('push');
                return { success: true };
            },
            remotePublish: async () => {
                calls.push('publish');
                return { success: true };
            },
            openOrReuse: async () => {
                calls.push('pr');
                return { success: true, kind: 'opened', pullRequest, reused: false };
            },
            now: () => 1_000,
        });

        const response = await runStacked({
            context: { cwd: '/repo', projectKey: 'test:/repo', detection: { isRepo: true, rootPath: '/repo', mode: '.git' } },
            request: {
                action: 'createPr',
                base: 'main',
                title: 'Ship stacked workflow',
                body: 'Push branch and PR.',
            },
        });

        expect(response).toMatchObject({
            success: true,
            branch: 'feature/pr-workflow',
            pullRequest,
        });
        expect(calls).toEqual(['publish', 'pr']);
    });

    it('publishes the active branch for pull requests when its upstream points at the base branch', async () => {
        const calls: string[] = [];
        const { createRunStackedPullRequestAction } = await import('./runStackedPullRequestAction');
        const runStacked = createRunStackedPullRequestAction({
            readSnapshot: async () => snapshot({
                branch: {
                    head: 'feature/pr-workflow',
                    upstream: 'origin/main',
                    ahead: 1,
                    behind: 0,
                    detached: false,
                },
                totals: {
                    includedFiles: 0,
                    pendingFiles: 0,
                    untrackedFiles: 0,
                    includedAdded: 0,
                    includedRemoved: 0,
                    pendingAdded: 0,
                    pendingRemoved: 0,
                },
            }),
            branchCreate: async () => {
                calls.push('branch');
                return { success: true };
            },
            commitCreate: async () => {
                calls.push('commit');
                return { success: true, commitSha: 'abc123' };
            },
            remotePush: async () => {
                calls.push('push');
                return { success: true };
            },
            remotePublish: async () => {
                calls.push('publish');
                return { success: true };
            },
            openOrReuse: async () => {
                calls.push('pr');
                return { success: true, kind: 'opened', pullRequest, reused: false };
            },
            now: () => 1_000,
        });

        const response = await runStacked({
            context: { cwd: '/repo', projectKey: 'test:/repo', detection: { isRepo: true, rootPath: '/repo', mode: '.git' } },
            request: {
                action: 'createPr',
                base: 'main',
                title: 'Ship stacked workflow',
                body: 'Publish branch and PR.',
            },
        });

        expect(response).toMatchObject({
            success: true,
            branch: 'feature/pr-workflow',
            pullRequest,
        });
        expect(calls).toEqual(['publish', 'pr']);
    });

    it('surfaces compare URL fallback from stacked pull request creation', async () => {
        const { createRunStackedPullRequestAction } = await import('./runStackedPullRequestAction');
        const runStacked = createRunStackedPullRequestAction({
            readSnapshot: async () => snapshot({
                branch: {
                    head: 'feature/pr-workflow',
                    upstream: 'origin/feature/pr-workflow',
                    ahead: 0,
                    behind: 0,
                    detached: false,
                },
                totals: {
                    includedFiles: 0,
                    pendingFiles: 0,
                    untrackedFiles: 0,
                    includedAdded: 0,
                    includedRemoved: 0,
                    pendingAdded: 0,
                    pendingRemoved: 0,
                },
            }),
            branchCreate: async () => ({ success: true }),
            commitCreate: async () => ({ success: true, commitSha: 'abc123' }),
            remotePush: async () => ({ success: true }),
            remotePublish: async () => ({ success: true }),
            openOrReuse: async () => ({
                success: true,
                kind: 'no-auth',
                composeUrl: 'https://github.com/happier-dev/happier/compare/main...feature/pr-workflow',
            }),
            now: () => 1_000,
        });

        const response = await runStacked({
            context: { cwd: '/repo', projectKey: 'test:/repo', detection: { isRepo: true, rootPath: '/repo', mode: '.git' } },
            request: {
                action: 'createPr',
                base: 'main',
                title: 'Ship stacked workflow',
                body: '',
            },
        });

        expect(response).toMatchObject({
            success: true,
            branch: 'feature/pr-workflow',
            composeUrl: 'https://github.com/happier-dev/happier/compare/main...feature/pr-workflow',
        });
    });

    it('commits and pushes an upstream feature branch without creating a pull request for commitPush', async () => {
        const calls: string[] = [];
        const { createRunStackedPullRequestAction } = await import('./runStackedPullRequestAction');
        const runStacked = createRunStackedPullRequestAction({
            readSnapshot: async () => snapshot({
                branch: {
                    head: 'feature/pr-workflow',
                    upstream: 'origin/feature/pr-workflow',
                    ahead: 1,
                    behind: 0,
                    detached: false,
                },
                capabilities: {
                    ...snapshot().capabilities,
                    defaultBranchPushPolicy: 'requires-feature-branch',
                },
            }),
            branchCreate: async () => {
                calls.push('branch');
                return { success: true };
            },
            commitCreate: async () => {
                calls.push('commit');
                return { success: true, commitSha: 'abc123' };
            },
            remotePush: async () => {
                calls.push('push');
                return { success: true };
            },
            remotePublish: async () => {
                calls.push('publish');
                return { success: true };
            },
            openOrReuse: async () => {
                calls.push('pr');
                return { success: true, kind: 'opened', pullRequest, reused: false };
            },
            now: () => 1_000,
        });

        const response = await runStacked({
            context: { cwd: '/repo', projectKey: 'test:/repo', detection: { isRepo: true, rootPath: '/repo', mode: '.git' } },
            request: {
                action: 'commitPush',
                commitMessage: 'Ship stacked workflow',
            },
        });

        expect(response).toMatchObject({
            success: true,
            branch: 'feature/pr-workflow',
            commitSha: 'abc123',
        });
        expect(calls).toEqual(['commit', 'push']);
    });
});
