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

function createCapabilities(
    overrides: Partial<NonNullable<ScmWorkingSnapshot['capabilities']>> = {},
): NonNullable<ScmWorkingSnapshot['capabilities']> {
    const capabilities = createSnapshot().capabilities;
    if (!capabilities) {
        throw new Error('Expected source control capabilities fixture');
    }
    return {
        ...capabilities,
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
                        nameWithOwner: 'acme/repo',
                        repositoryWebUrl: 'https://github.example.com/acme/repo',
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
                            nameWithOwner: 'acme/repo',
                            repositoryWebUrl: 'https://github.example.com/acme/repo',
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

    it('blocks existing PR open-url actions that escape a repository-scoped provider path on the same host', () => {
        const model = resolveSourceControlPullRequestViewModel({
            snapshot: createSnapshot({
                pullRequestStatus: {
                    provider: {
                        id: 'scm.github',
                        kind: 'github',
                        displayName: 'GitHub',
                        baseUrl: 'https://github.com',
                        nameWithOwner: 'acme/repo',
                        repositoryWebUrl: 'https://github.com/acme/repo',
                        urlSafety: { allowedSchemes: ['https:'] },
                    },
                    headBranch: 'feature/pr',
                    baseBranch: 'trunk',
                    openPullRequest: {
                        provider: {
                            id: 'scm.github',
                            kind: 'github',
                            displayName: 'GitHub',
                            baseUrl: 'https://github.com',
                            nameWithOwner: 'acme/repo',
                            repositoryWebUrl: 'https://github.com/acme/repo',
                            urlSafety: { allowedSchemes: ['https:'] },
                        },
                        number: 12,
                        title: 'Add update tab PR projection',
                        url: 'https://github.com/acme/other/pull/12',
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
        expect(model.blockedReason).toBe('unsafe-url');
        expect(model.primaryAction?.disabled).toBe(true);
    });

    it('blocks existing PR open-url actions when PR provider metadata does not match the detected provider', () => {
        const model = resolveSourceControlPullRequestViewModel({
            snapshot: createSnapshot({
                pullRequestStatus: {
                    provider: {
                        id: 'scm.github',
                        kind: 'github',
                        displayName: 'GitHub',
                        baseUrl: 'https://github.com',
                        nameWithOwner: 'acme/repo',
                        repositoryWebUrl: 'https://github.com/acme/repo',
                        urlSafety: { allowedSchemes: ['https:'] },
                    },
                    headBranch: 'feature/pr',
                    baseBranch: 'trunk',
                    openPullRequest: {
                        provider: {
                            id: 'scm.github',
                            kind: 'github',
                            displayName: 'GitHub',
                            baseUrl: 'https://github.com',
                            nameWithOwner: 'acme/other',
                            repositoryWebUrl: 'https://github.com/acme/other',
                            urlSafety: { allowedSchemes: ['https:'] },
                        },
                        number: 12,
                        title: 'Add update tab PR projection',
                        url: 'https://github.com/acme/other/pull/12',
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
        expect(model.blockedReason).toBe('unsafe-url');
        expect(model.primaryAction?.disabled).toBe(true);
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

    it('does not treat the current main worktree branch as a repository default branch', () => {
        const model = resolveSourceControlPullRequestViewModel({
            snapshot: createSnapshot({
                repo: {
                    isRepo: true,
                    rootPath: '/repo',
                    backendId: 'git',
                    mode: '.git',
                    defaultBranch: 'feature/from-main-worktree',
                    remotes: [],
                    worktrees: [
                        {
                            id: 'gitwt_main',
                            path: '/repo',
                            branch: 'feature/from-main-worktree',
                            isCurrent: true,
                            isMain: true,
                        },
                    ],
                },
                branch: {
                    head: 'feature/from-main-worktree',
                    upstream: 'origin/feature/from-main-worktree',
                    ahead: 1,
                    behind: 0,
                    detached: false,
                },
            }),
            disabled: false,
        });

        expect(model.kind).toBe('unavailable');
        expect(model.blockedReason).toBe('missing-base');
        expect(model.primaryAction).toBeNull();
    });

    it('projects open-compose when creation is unavailable but a compose URL is available', () => {
        const model = resolveSourceControlPullRequestViewModel({
            snapshot: createSnapshot({
                capabilities: createCapabilities({ writePullRequestCreate: false }),
                pullRequestStatus: {
                    provider: {
                        id: 'scm.github',
                        kind: 'github',
                        displayName: 'GitHub',
                        baseUrl: 'https://github.com/acme/repo',
                        nameWithOwner: 'acme/repo',
                        repositoryWebUrl: 'https://github.com/acme/repo',
                        urlSafety: { allowedSchemes: ['https:'] },
                    },
                    headBranch: 'feature/pr',
                    baseBranch: 'trunk',
                    openPullRequest: null,
                    composeUrl: 'https://github.com/acme/repo/compare/trunk...feature/pr',
                    authState: 'authentication_required',
                },
            }),
            disabled: false,
        });

        expect(model.kind).toBe('create');
        expect(model.blockedReason).toBeNull();
        expect(model.primaryAction?.kind).toBe('open-compose');
        expect(model.baseBranch).toBe('trunk');
        expect(model.headBranch).toBe('feature/pr');
    });

    it('blocks compose actions that escape a repository-scoped provider path on the same host', () => {
        const model = resolveSourceControlPullRequestViewModel({
            snapshot: createSnapshot({
                capabilities: createCapabilities({ writePullRequestCreate: false }),
                pullRequestStatus: {
                    provider: {
                        id: 'scm.github',
                        kind: 'github',
                        displayName: 'GitHub',
                        baseUrl: 'https://github.com',
                        nameWithOwner: 'acme/repo',
                        repositoryWebUrl: 'https://github.com/acme/repo',
                        urlSafety: { allowedSchemes: ['https:'] },
                    },
                    headBranch: 'feature/pr',
                    baseBranch: 'trunk',
                    openPullRequest: null,
                    composeUrl: 'https://github.com/acme/other/compare/trunk...feature/pr',
                    authState: 'authentication_required',
                },
            }),
            disabled: false,
        });

        expect(model.kind).toBe('unavailable');
        expect(model.blockedReason).toBe('unsafe-url');
        expect(model.primaryAction).toBeNull();
    });
});
