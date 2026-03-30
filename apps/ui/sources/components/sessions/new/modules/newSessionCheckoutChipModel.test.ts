import { describe, expect, it } from 'vitest';

import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

import { resolveNewSessionCheckoutChipModel } from './newSessionCheckoutChipModel';

function makeRepoSnapshot(partial?: Partial<ScmWorkingSnapshot>): ScmWorkingSnapshot {
    return {
        projectKey: 'machine-1:/repo/payments',
        fetchedAt: 123,
        repo: {
            isRepo: true,
            rootPath: '/repo/payments',
            backendId: 'git',
            mode: '.git',
            worktrees: [
                { path: '/repo/payments', branch: 'main', isCurrent: true },
                { path: '/repo/payments-feature-auth', branch: 'feature/auth', isCurrent: false },
                { path: '/repo/payments-release', branch: 'release', isCurrent: false },
            ],
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
            readBranches: true,
            writeBranchCreate: true,
            writeBranchCheckout: true,
            readStash: true,
            writeStash: true,
            worktreeCreate: true,
            changeSetModel: 'index',
            supportedDiffAreas: ['included', 'pending', 'both'],
        },
        branch: { head: 'main', upstream: 'origin/main', ahead: 0, behind: 0, detached: false },
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
        ...partial,
    };
}

describe('resolveNewSessionCheckoutChipModel', () => {
    it('returns only the no-worktree option when the selected path is not a git repo', () => {
        expect(
            resolveNewSessionCheckoutChipModel({
                selectedPath: '/tmp/random',
                checkoutCreationDraft: null,
                repoSnapshot: null,
            }),
        ).toEqual({
            selectedOptionId: 'current_path',
            options: [
                {
                    id: 'current_path',
                    kind: 'current_path',
                    path: '/tmp/random',
                },
            ],
        });
    });

    it('surfaces repo-native worktree options from the SCM snapshot instead of workspace checkouts', () => {
        expect(
            resolveNewSessionCheckoutChipModel({
                selectedPath: '/repo/payments',
                checkoutCreationDraft: null,
                repoSnapshot: makeRepoSnapshot(),
            }),
        ).toEqual({
            selectedOptionId: 'current_path',
            options: [
                {
                    id: 'current_path',
                    kind: 'current_path',
                    path: '/repo/payments',
                },
                {
                    id: 'create_git_worktree',
                    kind: 'create_git_worktree',
                },
                {
                    id: 'checkout:/repo/payments-feature-auth',
                    kind: 'linked_checkout',
                    path: '/repo/payments-feature-auth',
                    displayName: 'feature/auth',
                    checkoutKind: 'git_worktree',
                    gitBranch: 'feature/auth',
                },
                {
                    id: 'checkout:/repo/payments-release',
                    kind: 'linked_checkout',
                    path: '/repo/payments-release',
                    displayName: 'release',
                    checkoutKind: 'git_worktree',
                    gitBranch: 'release',
                },
            ],
        });
    });

    it('selects the existing repo worktree when the selected path is already inside it', () => {
        expect(
            resolveNewSessionCheckoutChipModel({
                selectedPath: '/repo/payments-feature-auth/src/components',
                checkoutCreationDraft: null,
                repoSnapshot: makeRepoSnapshot(),
            }).selectedOptionId,
        ).toBe('checkout:/repo/payments-feature-auth');
    });

    it('keeps an existing worktree selected when the scm snapshot root follows that linked worktree', () => {
        const model = resolveNewSessionCheckoutChipModel({
            selectedPath: '/repo/payments-feature-auth',
            checkoutCreationDraft: null,
            repoSnapshot: makeRepoSnapshot({
                repo: {
                    isRepo: true,
                    rootPath: '/repo/payments-feature-auth',
                    backendId: 'git',
                    mode: '.git',
                    worktrees: [
                        { path: '/repo/payments', branch: 'main', isCurrent: false, isMain: true },
                        { path: '/repo/payments-feature-auth', branch: 'feature/auth', isCurrent: true, isMain: false },
                        { path: '/repo/payments-release', branch: 'release', isCurrent: false, isMain: false },
                    ],
                },
            }),
        });

        expect(model.selectedOptionId).toBe('checkout:/repo/payments-feature-auth');
        expect(model.options.map((option) => option.id)).toEqual([
            'current_path',
            'create_git_worktree',
            'checkout:/repo/payments-feature-auth',
            'checkout:/repo/payments-release',
        ]);
        expect(model.options[0]).toEqual({
            id: 'current_path',
            kind: 'current_path',
            path: '/repo/payments',
        });
    });

    it('keeps the worktree creation option selected when an in-memory draft exists', () => {
        expect(
            resolveNewSessionCheckoutChipModel({
                selectedPath: '/repo/payments',
                checkoutCreationDraft: {
                    kind: 'git_worktree',
                    displayName: 'feature/payment-sync',
                    baseRef: 'main',
                },
                repoSnapshot: makeRepoSnapshot(),
            }).selectedOptionId,
        ).toBe('create_git_worktree');
    });

    it('keeps repo-native worktree creation available even when no workspace is linked', () => {
        expect(
            resolveNewSessionCheckoutChipModel({
                selectedPath: '/repo/payments',
                checkoutCreationDraft: null,
                repoSnapshot: makeRepoSnapshot(),
            }).options.map((option) => option.id),
        ).toEqual([
            'current_path',
            'create_git_worktree',
            'checkout:/repo/payments-feature-auth',
            'checkout:/repo/payments-release',
        ]);
    });

    it('puts no-worktree first, then new worktree, then existing worktrees', () => {
        expect(
            resolveNewSessionCheckoutChipModel({
                selectedPath: '/repo/payments',
                checkoutCreationDraft: null,
                repoSnapshot: makeRepoSnapshot(),
            }).options.map((option) => option.id),
        ).toEqual([
            'current_path',
            'create_git_worktree',
            'checkout:/repo/payments-feature-auth',
            'checkout:/repo/payments-release',
        ]);
    });
});
