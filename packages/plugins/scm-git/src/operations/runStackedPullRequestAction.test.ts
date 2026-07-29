import { describe, expect, it, vi } from 'vitest';

import type {
  ScmBranchCreateResponse,
  ScmCommitCreateResponse,
  ScmPullRequestOpenOrReuseResponse,
  ScmRemotePublishResponse,
  ScmRemoteResponse,
  ScmWorkingSnapshot,
} from '@happier-dev/plugin-sdk/experimental/scm';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/experimental/scm';

import type { ScmBackendContext } from '../types.js';
import { createGitRunStackedPullRequestAction } from './runStackedPullRequestAction.js';

const context: ScmBackendContext = {
    cwd: '/repo',
    projectKey: 'machine:/repo',
    detection: { isRepo: true, rootPath: '/repo', mode: '.git' },
};

function createSnapshot(input?: Partial<ScmWorkingSnapshot['branch']>): ScmWorkingSnapshot {
    return {
        projectKey: context.projectKey,
        fetchedAt: 100,
        repo: {
            isRepo: true,
            rootPath: '/repo',
            backendId: 'git',
            mode: '.git',
            remotes: [{ name: 'origin', fetchUrl: 'https://github.com/happier-dev/happier.git' }],
            worktrees: [],
        },
        capabilities: { capabilityScope: 'local-backend' },
        branch: {
            head: 'feature/scm-pr-7',
            upstream: 'origin/main',
            ahead: 1,
            behind: 0,
            detached: false,
            ...input,
        },
        hostingProvider: null,
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

describe('run stacked pull request action', () => {
    it('records ordered progress and returns the validated nextAction from open-or-reuse on success', async () => {
        const commit = vi.fn(async (): Promise<ScmCommitCreateResponse> => ({ success: true, commitSha: 'abc123' }));
        const push = vi.fn(async (): Promise<ScmRemoteResponse> => ({ success: true, stdout: '', stderr: '' }));
        const openOrReuse = vi.fn(async (): Promise<ScmPullRequestOpenOrReuseResponse> => ({
            success: true,
            pullRequest: null,
            composeUrl: 'https://github.com/happier-dev/happier/compare/main...feature',
            nextAction: {
                kind: 'openUrl',
                purpose: 'compose',
                url: 'https://github.com/happier-dev/happier/compare/main...feature',
                allowedBaseUrl: 'https://github.com',
                urlSafety: { allowedSchemes: ['https:'] },
            },
        }));
        const action = createGitRunStackedPullRequestAction({
            commitCreate: commit,
            remotePush: push,
            pullRequestOpenOrReuse: openOrReuse,
            now: () => 1234,
        });

        const response = await action.runStacked({
            context,
            request: {
                cwd: '/repo',
                action: 'commitPushAndOpenOrReuse',
                commitMessage: 'Commit stacked changes',
                base: 'main',
                head: 'feature',
            },
        });

        expect(response).toMatchObject({
            success: true,
            commitSha: 'abc123',
            nextAction: {
                kind: 'openUrl',
                purpose: 'compose',
                allowedBaseUrl: 'https://github.com',
            },
        });
        expect(response.events.map((event) => `${event.kind}:${event.phase ?? 'action'}`)).toEqual([
            'action_started:action',
            'phase_started:commit',
            'phase_finished:commit',
            'phase_started:push',
            'phase_finished:push',
            'phase_started:pr',
            'phase_finished:pr',
            'action_finished:action',
        ]);
    });

    it('appends a durable failure event before returning a failed phase response', async () => {
        const action = createGitRunStackedPullRequestAction({
            commitCreate: async () => ({
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.COMMIT_REQUIRED,
                error: 'Nothing to commit',
            }),
            now: () => 1234,
        });

        const response = await action.runStacked({
            context,
            request: {
                cwd: '/repo',
                action: 'commit',
                commitMessage: 'Commit stacked changes',
            },
        });

        expect(response).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.COMMIT_REQUIRED,
        });
        expect(response.events.at(-1)).toMatchObject({
            kind: 'action_failed',
            phase: 'commit',
            timestamp: 1234,
        });
    });

    it('uses active-branch publish safety instead of raw push when upstream points at the base branch', async () => {
        const push = vi.fn(async (): Promise<ScmRemoteResponse> => ({ success: true, stdout: '', stderr: '' }));
        const publishActiveBranch = vi.fn(async () => ({ success: true }));
        const openOrReuse = vi.fn(async (): Promise<ScmPullRequestOpenOrReuseResponse> => ({
            success: true,
            pullRequest: null,
            nextAction: { kind: 'none' },
        }));
        const action = createGitRunStackedPullRequestAction({
            remotePush: push,
            pullRequestOpenOrReuse: openOrReuse,
            readSnapshot: async () => createSnapshot(),
            publishActiveBranch,
            now: () => 1234,
        });

        const response = await action.runStacked({
            context,
            request: {
                cwd: '/repo',
                action: 'pushAndOpenOrReuse',
                base: 'main',
                title: 'Publish active branch safely',
            },
        });

        expect(response.success).toBe(true);
        expect(push).not.toHaveBeenCalled();
        expect(publishActiveBranch).toHaveBeenCalledWith({
            context,
            request: { cwd: '/repo' },
            headBranch: 'feature/scm-pr-7',
            reason: 'upstream_points_at_base',
        });
    });

    it('blocks explicit default-branch heads before the push phase', async () => {
        const push = vi.fn(async (): Promise<ScmRemoteResponse> => ({ success: true, stdout: '', stderr: '' }));
        const publishActiveBranch = vi.fn(async () => ({ success: true }));
        const openOrReuse = vi.fn(async (): Promise<ScmPullRequestOpenOrReuseResponse> => ({
            success: true,
            pullRequest: null,
            nextAction: { kind: 'none' },
        }));
        const action = createGitRunStackedPullRequestAction({
            remotePush: push,
            pullRequestOpenOrReuse: openOrReuse,
            readSnapshot: async () => ({
                ...createSnapshot({ head: 'main', upstream: null, ahead: 1 }),
                capabilities: {
                    capabilityScope: 'local-backend',
                    defaultBranchPushPolicy: 'requires-feature-branch',
                },
            }),
            publishActiveBranch,
            now: () => 1234,
        });

        const response = await action.runStacked({
            context,
            request: {
                cwd: '/repo',
                action: 'pushAndOpenOrReuse',
                base: 'main',
                head: 'main',
                title: 'Do not push main',
                defaultBranchPushPolicy: 'requires-feature-branch',
            },
        });

        expect(response).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
        });
        expect(push).not.toHaveBeenCalled();
        expect(publishActiveBranch).not.toHaveBeenCalled();
        expect(openOrReuse).not.toHaveBeenCalled();
        expect(response.events.at(-1)).toMatchObject({
            kind: 'action_failed',
        });
    });

    it('blocks implicit default-branch heads before committing', async () => {
        const commit = vi.fn(async (): Promise<ScmCommitCreateResponse> => ({ success: true, commitSha: 'abc123' }));
        const action = createGitRunStackedPullRequestAction({
            commitCreate: commit,
            readSnapshot: async () => ({
                ...createSnapshot({ head: 'main', upstream: 'origin/main', ahead: 1 }),
                capabilities: {
                    capabilityScope: 'local-backend',
                    defaultBranchPushPolicy: 'requires-feature-branch',
                },
            }),
            now: () => 1234,
        });

        const response = await action.runStacked({
            context,
            request: {
                cwd: '/repo',
                action: 'commitPushAndOpenOrReuse',
                base: 'main',
                commitMessage: 'Should not commit on default branch',
                title: 'Should not open from default branch',
            },
        });

        expect(response).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
        });
        expect(commit).not.toHaveBeenCalled();
    });

    it('uses the requested feature branch as the push and pull-request head', async () => {
        const push = vi.fn(async (): Promise<ScmRemoteResponse> => ({ success: true, stdout: '', stderr: '' }));
        const openOrReuse = vi.fn(async (): Promise<ScmPullRequestOpenOrReuseResponse> => ({
            success: true,
            pullRequest: null,
            nextAction: { kind: 'none' },
        }));
        const action = createGitRunStackedPullRequestAction({
            remotePush: push,
            pullRequestOpenOrReuse: openOrReuse,
            readSnapshot: async () => createSnapshot({
                head: 'feature/generated',
                upstream: null,
                ahead: 1,
            }),
            now: () => 1234,
        });

        const response = await action.runStacked({
            context,
            request: {
                cwd: '/repo',
                action: 'pushAndOpenOrReuse',
                base: 'main',
                featureBranch: 'feature/generated',
                title: 'Open generated feature branch',
            },
        });

        expect(response).toMatchObject({
            success: true,
            branch: 'feature/generated',
        });
        expect(push).toHaveBeenCalledWith({
            context,
            request: { cwd: '/repo', branch: 'feature/generated' },
        });
        expect(openOrReuse).toHaveBeenCalledWith({
            context,
            request: {
                cwd: '/repo',
                base: 'main',
                head: 'feature/generated',
                title: 'Open generated feature branch',
            },
        });
    });

    it('blocks requested feature branches that are not the active worktree branch before committing', async () => {
        const commit = vi.fn(async (): Promise<ScmCommitCreateResponse> => ({ success: true, commitSha: 'abc123' }));
        const push = vi.fn(async (): Promise<ScmRemoteResponse> => ({ success: true, stdout: '', stderr: '' }));
        const openOrReuse = vi.fn(async (): Promise<ScmPullRequestOpenOrReuseResponse> => ({
            success: true,
            pullRequest: null,
            nextAction: { kind: 'none' },
        }));
        const action = createGitRunStackedPullRequestAction({
            commitCreate: commit,
            remotePush: push,
            pullRequestOpenOrReuse: openOrReuse,
            readSnapshot: async () => createSnapshot({ head: 'main', upstream: 'origin/main', ahead: 1 }),
            now: () => 1234,
        });

        const response = await action.runStacked({
            context,
            request: {
                cwd: '/repo',
                action: 'commitPushAndOpenOrReuse',
                base: 'main',
                featureBranch: 'feature/generated',
                commitMessage: 'Should not commit on main',
                title: 'Open generated feature branch',
            },
        });

        expect(response).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
        });
        expect(commit).not.toHaveBeenCalled();
        expect(push).not.toHaveBeenCalled();
        expect(openOrReuse).not.toHaveBeenCalled();
    });

    it('creates and publishes a requested feature branch before committing from a default branch that requires feature branches', async () => {
        const calls: string[] = [];
        const branchCreate = vi.fn(async (): Promise<ScmBranchCreateResponse> => {
            calls.push('branch');
            return { success: true, stdout: '', stderr: '' };
        });
        const commit = vi.fn(async (): Promise<ScmCommitCreateResponse> => {
            calls.push('commit');
            return { success: true, commitSha: 'abc123' };
        });
        const publish = vi.fn(async (): Promise<ScmRemotePublishResponse> => {
            calls.push('publish');
            return { success: true, stdout: '', stderr: '' };
        });
        const push = vi.fn(async (): Promise<ScmRemoteResponse> => {
            calls.push('push');
            return { success: true, stdout: '', stderr: '' };
        });
        const openOrReuse = vi.fn(async (): Promise<ScmPullRequestOpenOrReuseResponse> => {
            calls.push('pr');
            return {
                success: true,
                pullRequest: null,
                nextAction: { kind: 'none' },
            };
        });
        const action = createGitRunStackedPullRequestAction({
            branchCreate,
            commitCreate: commit,
            remotePush: push,
            publishActiveBranch: publish,
            pullRequestOpenOrReuse: openOrReuse,
            readSnapshot: async () => ({
                ...createSnapshot({ head: 'main', upstream: 'origin/main', ahead: 1 }),
                capabilities: {
                    capabilityScope: 'local-backend',
                    defaultBranchPushPolicy: 'requires-feature-branch',
                },
            }),
            now: () => 1234,
        });

        const response = await action.runStacked({
            context,
            request: {
                cwd: '/repo',
                action: 'commitPushAndOpenOrReuse',
                base: 'main',
                featureBranch: 'feature/generated',
                commitMessage: 'Commit on generated feature branch',
                title: 'Open generated feature branch',
            },
        });

        expect(response).toMatchObject({
            success: true,
            branch: 'feature/generated',
            commitSha: 'abc123',
        });
        expect(calls).toEqual(['branch', 'commit', 'publish', 'pr']);
        expect(branchCreate).toHaveBeenCalledWith({
            context,
            request: {
                cwd: '/repo',
                name: 'feature/generated',
                checkout: true,
                startPoint: 'main',
            },
        });
        expect(push).not.toHaveBeenCalled();
        expect(publish).toHaveBeenCalledWith({
            context,
            request: { cwd: '/repo' },
            headBranch: 'feature/generated',
            reason: 'missing_upstream',
        });
        expect(openOrReuse).toHaveBeenCalledWith({
            context,
            request: {
                cwd: '/repo',
                base: 'main',
                head: 'feature/generated',
                title: 'Open generated feature branch',
            },
        });
        expect(response.events.map((event) => `${event.kind}:${event.phase ?? 'action'}`)).toEqual([
            'action_started:action',
            'phase_started:branch',
            'phase_finished:branch',
            'phase_started:commit',
            'phase_finished:commit',
            'phase_started:push',
            'phase_finished:push',
            'phase_started:pr',
            'phase_finished:pr',
            'action_finished:action',
        ]);
    });

    it('blocks requested feature-branch commits when the active branch cannot be verified', async () => {
        const commit = vi.fn(async (): Promise<ScmCommitCreateResponse> => ({ success: true, commitSha: 'abc123' }));
        const action = createGitRunStackedPullRequestAction({
            commitCreate: commit,
            readSnapshot: async () => null,
            now: () => 1234,
        });

        const response = await action.runStacked({
            context,
            request: {
                cwd: '/repo',
                action: 'commitPushAndOpenOrReuse',
                base: 'main',
                featureBranch: 'feature/generated',
                commitMessage: 'Should not commit without branch verification',
                title: 'Open generated feature branch',
            },
        });

        expect(response).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
        });
        expect(commit).not.toHaveBeenCalled();
    });

    it('rejects conflicting requested head and feature branches before mutating', async () => {
        const commit = vi.fn(async (): Promise<ScmCommitCreateResponse> => ({ success: true, commitSha: 'abc123' }));
        const push = vi.fn(async (): Promise<ScmRemoteResponse> => ({ success: true, stdout: '', stderr: '' }));
        const openOrReuse = vi.fn(async (): Promise<ScmPullRequestOpenOrReuseResponse> => ({
            success: true,
            pullRequest: null,
            nextAction: { kind: 'none' },
        }));
        const action = createGitRunStackedPullRequestAction({
            commitCreate: commit,
            remotePush: push,
            pullRequestOpenOrReuse: openOrReuse,
            readSnapshot: async () => createSnapshot({
                head: 'feature/generated',
                upstream: null,
                ahead: 1,
            }),
            now: () => 1234,
        });

        const response = await action.runStacked({
            context,
            request: {
                cwd: '/repo',
                action: 'commitPushAndOpenOrReuse',
                base: 'main',
                head: 'feature/manual',
                featureBranch: 'feature/generated',
                commitMessage: 'Should not commit ambiguous branch request',
                title: 'Open generated feature branch',
            },
        });

        expect(response).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
        });
        expect(commit).not.toHaveBeenCalled();
        expect(push).not.toHaveBeenCalled();
        expect(openOrReuse).not.toHaveBeenCalled();
    });

    it('blocks explicit base-to-base heads even when another branch is active', async () => {
        const push = vi.fn(async (): Promise<ScmRemoteResponse> => ({ success: true, stdout: '', stderr: '' }));
        const openOrReuse = vi.fn(async (): Promise<ScmPullRequestOpenOrReuseResponse> => ({
            success: true,
            pullRequest: null,
            nextAction: { kind: 'none' },
        }));
        const action = createGitRunStackedPullRequestAction({
            remotePush: push,
            pullRequestOpenOrReuse: openOrReuse,
            readSnapshot: async () => createSnapshot({ head: 'feature/scm-pr-7', upstream: 'origin/feature/scm-pr-7' }),
            now: () => 1234,
        });

        const response = await action.runStacked({
            context,
            request: {
                cwd: '/repo',
                action: 'pushAndOpenOrReuse',
                base: 'main',
                head: 'main',
                title: 'Do not push base branch explicitly',
            },
        });

        expect(response).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
        });
        expect(push).not.toHaveBeenCalled();
        expect(openOrReuse).not.toHaveBeenCalled();
    });

    it('blocks explicit base-to-base heads before committing or opening a pull request', async () => {
        const commit = vi.fn(async (): Promise<ScmCommitCreateResponse> => ({ success: true, commitSha: 'abc123' }));
        const openOrReuse = vi.fn(async (): Promise<ScmPullRequestOpenOrReuseResponse> => ({
            success: true,
            pullRequest: null,
            nextAction: { kind: 'none' },
        }));
        const action = createGitRunStackedPullRequestAction({
            commitCreate: commit,
            pullRequestOpenOrReuse: openOrReuse,
            now: () => 1234,
        });

        const commitResponse = await action.runStacked({
            context,
            request: {
                cwd: '/repo',
                action: 'commitPushAndOpenOrReuse',
                base: 'main',
                head: 'main',
                commitMessage: 'Should not commit',
            },
        });
        const openResponse = await action.runStacked({
            context,
            request: {
                cwd: '/repo',
                action: 'openOrReuse',
                base: 'main',
                head: 'main',
                title: 'Should not open',
            },
        });

        expect(commitResponse).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
        });
        expect(openResponse).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
        });
        expect(commit).not.toHaveBeenCalled();
        expect(openOrReuse).not.toHaveBeenCalled();
    });
});
