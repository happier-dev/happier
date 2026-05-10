import { describe, expect, it } from 'vitest';

import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

import { resolveSourceControlPullRequestViewModel } from './resolveSourceControlPullRequestViewModel';

function createSnapshot(overrides: Partial<ScmWorkingSnapshot> = {}): ScmWorkingSnapshot {
    return {
        fetchedAt: 1,
        projectKey: 'machine:/repo',
        repo: {
            isRepo: true,
            rootPath: '/repo',
            backendId: 'git',
            mode: '.git',
            defaultBranch: 'trunk',
            remotes: [],
            worktrees: [],
        },
        capabilities: {
            readStatus: true,
            readDiffFile: true,
            readDiffCommit: true,
            readLog: true,
            writeInclude: true,
            writeExclude: true,
            writeCommit: true,
            writeBackout: true,
            writeRemoteFetch: true,
            writeRemotePull: true,
            writeRemotePush: true,
            readPullRequestStatus: true,
            writePullRequestCreate: true,
            worktreeCreate: true,
            changeSetModel: 'index',
            supportedDiffAreas: ['both'],
        },
        branch: {
            head: 'feature/pr',
            upstream: 'origin/feature/pr',
            ahead: 1,
            behind: 0,
            detached: false,
        },
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

describe('resolveSourceControlPullRequestViewModel', () => {
    it('projects an existing PR without offering duplicate creation', () => {
        const model = resolveSourceControlPullRequestViewModel({
            snapshot: createSnapshot({
                pullRequestStatus: {
                    provider: {
                        id: 'scm.github.enterprise',
                        kind: 'github',
                        displayName: 'GitHub Enterprise',
                        baseUrl: 'https://github.example.com/acme/repo',
                        urlSafety: { allowedSchemes: ['https:'] },
                    },
                    headBranch: 'feature/pr',
                    baseBranch: 'trunk',
                    openPullRequest: {
                        provider: {
                            id: 'scm.github.enterprise',
                            kind: 'github',
                            displayName: 'GitHub Enterprise',
                            baseUrl: 'https://github.example.com/acme/repo',
                            urlSafety: { allowedSchemes: ['https:'] },
                        },
                        number: 12,
                        title: 'Add update tab PR projection',
                        url: 'https://github.example.com/acme/repo/pull/12',
                        baseBranch: 'trunk',
                        headBranch: 'feature/pr',
                        state: 'open',
                    },
                    authState: 'authenticated',
                },
            }),
            disabled: false,
        });

        expect(model.kind).toBe('existing');
        expect(model.primaryAction?.kind).toBe('open-url');
        expect(model.secondaryAction?.kind).not.toBe('open-or-reuse');
        expect(model.baseBranch).toBe('trunk');
    });

    it('uses the backend-detected default branch as the PR base branch', () => {
        const model = resolveSourceControlPullRequestViewModel({
            snapshot: createSnapshot(),
            disabled: false,
        });

        expect(model.kind).toBe('create');
        expect(model.baseBranch).toBe('trunk');
        expect(model.primaryAction?.kind).toBe('open-or-reuse');
    });
});
