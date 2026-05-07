import { describe, expect, it } from 'vitest';

import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { buildPullRequestUiModel } from './pullRequestUiModel';

function snapshot(overrides: Partial<ScmWorkingSnapshot> = {}): ScmWorkingSnapshot {
    return {
        projectKey: 'machine:/repo',
        fetchedAt: 1,
        repo: {
            isRepo: true,
            rootPath: '/repo',
            backendId: 'git',
            mode: '.git',
            remotes: [],
            worktrees: [],
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
            writeBranchCreate: true,
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
            head: 'feature/prs',
            upstream: 'origin/main',
            ahead: 1,
            behind: 0,
            detached: false,
        },
        hostingProvider: {
            kind: 'github',
            name: 'GitHub',
            baseUrl: 'https://github.com',
            nameWithOwner: 'happier/dev',
            remoteName: 'origin',
        },
        pullRequest: null,
        stashCount: 0,
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

describe('buildPullRequestUiModel', () => {
    it('returns existing PR state when the snapshot has a current branch pull request', () => {
        const model = buildPullRequestUiModel(snapshot({
            pullRequest: {
                provider: {
                    kind: 'github',
                    name: 'GitHub',
                    baseUrl: 'https://github.com',
                    nameWithOwner: 'happier/dev',
                    remoteName: 'origin',
                },
                number: 42,
                title: 'Add PR workflow',
                url: 'https://github.com/happier/dev/pull/42',
                baseBranch: 'main',
                headBranch: 'feature/prs',
                state: 'open',
            },
        }));

        expect(model.kind).toBe('existing_pull_request');
        if (model.kind !== 'existing_pull_request') return;
        expect(model.numberLabel).toBe('#42');
        expect(model.branchLabel).toBe('feature/prs -> main');
    });

    it('returns create-ready state with the default base branch even when upstream tracks the feature branch', () => {
        const model = buildPullRequestUiModel(snapshot({
            branch: {
                head: 'feature/prs',
                upstream: 'origin/feature/prs',
                ahead: 1,
                behind: 0,
                detached: false,
            },
        }));

        expect(model.kind).toBe('ready_to_create');
        if (model.kind !== 'ready_to_create') return;
        expect(model.baseBranch).toBe('main');
        expect(model.headBranch).toBe('feature/prs');
        expect(model.createBlockedReason).toBeNull();
    });

    it('uses the upstream branch as the PR base when the branch tracks a different target branch', () => {
        const model = buildPullRequestUiModel(snapshot({
            branch: {
                head: 'feature/prs',
                upstream: 'origin/master',
                ahead: 1,
                behind: 0,
                detached: false,
            },
        }));

        expect(model.kind).toBe('ready_to_create');
        if (model.kind !== 'ready_to_create') return;
        expect(model.baseBranch).toBe('master');
        expect(model.headBranch).toBe('feature/prs');
        expect(model.createBlockedReason).toBeNull();
    });

    it('offers feature-branch creation on a clean default branch', () => {
        const model = buildPullRequestUiModel(snapshot({
            branch: {
                head: 'main',
                upstream: 'origin/main',
                ahead: 0,
                behind: 0,
                detached: false,
            },
        }));

        expect(model.kind).toBe('ready_to_create');
        if (model.kind !== 'ready_to_create') return;
        expect(model.createBlockedReason).toBe('default_branch_requires_feature');
        expect(model.defaultBranchAction).toMatchObject({
            kind: 'create_feature_branch',
            suggestedBranchName: 'feature/dev-update',
        });
    });

    it('offers feature-branch PR creation when the default branch has local commits', () => {
        const model = buildPullRequestUiModel(snapshot({
            branch: {
                head: 'main',
                upstream: 'origin/main',
                ahead: 2,
                behind: 0,
                detached: false,
            },
        }));

        expect(model.kind).toBe('ready_to_create');
        if (model.kind !== 'ready_to_create') return;
        expect(model.defaultBranchAction).toMatchObject({
            kind: 'create_feature_branch_and_open_pr',
            action: 'createPr',
            suggestedBranchName: 'feature/dev-update',
        });
    });

    it('uses the repository default branch when a non-main branch tracks itself', () => {
        const model = buildPullRequestUiModel(snapshot({
            repo: {
                isRepo: true,
                rootPath: '/repo',
                backendId: 'git',
                mode: '.git',
                remotes: [],
                worktrees: [{ path: '/repo', branch: 'develop', isCurrent: true, isMain: true }],
            },
            branch: {
                head: 'develop',
                upstream: 'origin/develop',
                ahead: 0,
                behind: 0,
                detached: false,
            },
        }));

        expect(model.kind).toBe('ready_to_create');
        if (model.kind !== 'ready_to_create') return;
        expect(model.baseBranch).toBe('develop');
        expect(model.createBlockedReason).toBe('default_branch_requires_feature');
    });

    it('uses the repository default branch when a feature branch has no upstream', () => {
        const model = buildPullRequestUiModel(snapshot({
            repo: {
                isRepo: true,
                rootPath: '/repo',
                backendId: 'git',
                mode: '.git',
                remotes: [],
                worktrees: [
                    { path: '/repo', branch: 'develop', isCurrent: false, isMain: true },
                    { path: '/repo-feature', branch: 'feature/prs', isCurrent: true, isMain: false },
                ],
            },
            branch: {
                head: 'feature/prs',
                upstream: null,
                ahead: 1,
                behind: 0,
                detached: false,
            },
        }));

        expect(model.kind).toBe('ready_to_create');
        if (model.kind !== 'ready_to_create') return;
        expect(model.baseBranch).toBe('develop');
        expect(model.createBlockedReason).toBeNull();
    });

    it('keeps PR creation disabled in the ready model when the backend does not allow PR creation', () => {
        const base = snapshot();
        const model = buildPullRequestUiModel(snapshot({
            capabilities: {
                ...base.capabilities!,
                writePullRequestCreate: false,
            },
        }));

        expect(model.kind).toBe('ready_to_create');
        if (model.kind !== 'ready_to_create') return;
        expect(model.canCreatePullRequest).toBe(false);
    });

    it('uses stacked PR creation for unpublished feature branches', () => {
        const model = buildPullRequestUiModel(snapshot({
            branch: {
                head: 'feature/prs',
                upstream: null,
                ahead: 1,
                behind: 0,
                detached: false,
            },
        }));

        expect(model.kind).toBe('ready_to_create');
        if (model.kind !== 'ready_to_create') return;
        expect(model.createStrategy).toEqual({ kind: 'run_stacked_create_pr' });
    });

    it('blocks open-or-reuse for dirty unpublished feature branches', () => {
        const model = buildPullRequestUiModel(snapshot({
            branch: {
                head: 'feature/prs',
                upstream: null,
                ahead: 1,
                behind: 0,
                detached: false,
            },
            totals: {
                includedFiles: 1,
                pendingFiles: 0,
                untrackedFiles: 0,
                includedAdded: 0,
                includedRemoved: 0,
                pendingAdded: 0,
                pendingRemoved: 0,
            },
        }));

        expect(model.kind).toBe('ready_to_create');
        if (model.kind !== 'ready_to_create') return;
        expect(model.createStrategy).toEqual({
            kind: 'open_or_reuse',
            disabledReason: 'dirty_unpublished_branch',
        });
    });

    it('uses stacked PR creation for ahead feature branches without requiring publish capability', () => {
        const base = snapshot();
        const model = buildPullRequestUiModel(snapshot({
            capabilities: {
                ...base.capabilities!,
                writeRemotePublish: false,
            },
            branch: {
                head: 'feature/prs',
                upstream: 'origin/feature/prs',
                ahead: 1,
                behind: 0,
                detached: false,
            },
        }));

        expect(model.kind).toBe('ready_to_create');
        if (model.kind !== 'ready_to_create') return;
        expect(model.createStrategy).toEqual({ kind: 'run_stacked_create_pr' });
    });

    it('returns detached state before provider-specific actions', () => {
        const model = buildPullRequestUiModel(snapshot({
            branch: {
                head: null,
                upstream: null,
                ahead: 0,
                behind: 0,
                detached: true,
            },
        }));

        expect(model.kind).toBe('detached_head');
    });
});
