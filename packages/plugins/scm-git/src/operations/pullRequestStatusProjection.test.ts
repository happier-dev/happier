import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import type {
  ScmHostingProviderRef,
  ScmPullRequestSummary,
  ScmWorkingSnapshot,
} from '@happier-dev/plugin-sdk/experimental/scm';

import { createPrStatusCache } from '../hostingProviders/prStatusCache.js';
import {
    projectPullRequestStatus,
    resolveDefaultPullRequestStatusProjectionRegistry,
} from './pullRequestStatusProjection.js';
import {
    createEmptyScmHostingProviderRegistry,
    createScmHostingProviderRuntimeServicesForTest,
    runWithRealGitScmRuntime,
} from '../testkit/scmRuntime.test-support.js';

const provider: ScmHostingProviderRef = {
    id: 'scm.github',
    kind: 'github',
    displayName: 'GitHub',
    baseUrl: 'https://github.com',
    nameWithOwner: 'happier-dev/happier',
    remoteName: 'origin',
    urlSafety: { allowedSchemes: ['https:'] },
};

function createSnapshot(): ScmWorkingSnapshot {
    return {
        projectKey: 'machine-1:/repo',
        fetchedAt: 123,
        repo: {
            isRepo: true,
            rootPath: '/repo',
            backendId: 'git',
            mode: '.git',
            worktrees: [],
            remotes: [{
                name: 'origin',
                fetchUrl: 'git@github.com:happier-dev/happier.git',
                pushUrl: 'git@github.com:happier-dev/happier.git',
            }],
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

function createRegistry() {
    return {
        detectRemote() {
            return {
                kind: 'resolved' as const,
                providerId: provider.id,
                provider,
            };
        },
        buildCompareUrl() {
            return {
                kind: 'resolved' as const,
                url: 'https://github.com/happier-dev/happier/compare/main...feature/pr-cache',
            };
        },
    };
}

describe('pull request status projection', () => {
    it('does not construct a second first-party SCM provider plugin registry', () => {
        const source = readFileSync(new URL('./pullRequestStatusProjection.ts', import.meta.url), 'utf8');

        expect(source).not.toMatch(/@happier-dev\/plugins-scm-/);
        expect(source).not.toMatch(/\bactivate[A-Za-z0-9_]*Plugin\b/);
        expect(source).not.toMatch(/\bPLUGIN_MANIFEST\b/);
        expect(source).not.toContain('../hostingProviders/registry');
        expect(source).not.toContain('createScmHostingProviderRegistry');
    });

    it('requires the host-injected hosting provider registry resolver for default projection registry resolution', async () => {
        await expect(resolveDefaultPullRequestStatusProjectionRegistry()).rejects.toThrow(/host-injected SCM hosting provider registry/i);
    });

    it('resolves the default projection registry from package testkit-installed host runtime services', async () => {
        const registry = createEmptyScmHostingProviderRegistry();

        const resolved = await runWithRealGitScmRuntime(
            () => resolveDefaultPullRequestStatusProjectionRegistry(),
            {
                hostingProviderRuntimeServices: createScmHostingProviderRuntimeServicesForTest(registry),
            },
        );

        expect(resolved).toBe(registry);
    });

    it('projects hosting provider and fresh cached PR status without mutating snapshot entries', () => {
        const cache = createPrStatusCache({ now: () => 1000 });
        const pullRequest: ScmPullRequestSummary = {
            provider,
            number: 42,
            title: 'Ship SCM PR cache',
            url: 'https://github.com/happier-dev/happier/pull/42',
            baseBranch: 'main',
            headBranch: 'feature/pr-cache',
            state: 'open',
        };
        cache.setSuccess({
            key: {
                workspaceKey: 'machine-1:/repo',
                repoRootPath: '/repo',
                provider,
                baseBranch: 'main',
                headBranch: 'feature/pr-cache',
                state: 'open',
                authProfileKey: 'profile-a',
            },
            pullRequests: [pullRequest],
        });

        const snapshot = createSnapshot();
        const projected = projectPullRequestStatus({
            snapshot,
            registry: createRegistry(),
            cache,
            now: () => 1000,
        });

        expect(projected.hostingProvider).toMatchObject({
            id: 'scm.github',
            nameWithOwner: 'happier-dev/happier',
        });
        expect(projected.pullRequestStatus).toMatchObject({
            headBranch: 'feature/pr-cache',
            baseBranch: 'main',
            openPullRequest: pullRequest,
            composeUrl: 'https://github.com/happier-dev/happier/compare/main...feature/pr-cache',
        });
        expect(projected.entries).toBe(snapshot.entries);
        expect(projected.totals).toBe(snapshot.totals);
    });

    it('prefers the upstream remote hosting provider before origin in multi-remote repositories', () => {
        const snapshot = createSnapshot();
        const projected = projectPullRequestStatus({
            snapshot: {
                ...snapshot,
                repo: {
                    ...snapshot.repo,
                    remotes: [
                        {
                            name: 'origin',
                            fetchUrl: 'https://gitlab.com/happier-dev/fork.git',
                            pushUrl: 'https://gitlab.com/happier-dev/fork.git',
                        },
                        {
                            name: 'upstream',
                            fetchUrl: 'git@github.com:happier-dev/happier.git',
                            pushUrl: 'git@github.com:happier-dev/happier.git',
                        },
                    ],
                },
                branch: {
                    ...snapshot.branch,
                    upstream: 'upstream/feature/pr-cache',
                },
            },
            registry: {
                detectRemote({ remoteName, remoteUrl }) {
                    if (remoteName === 'upstream' && remoteUrl.includes('github.com')) {
                        return {
                            kind: 'resolved' as const,
                            providerId: provider.id,
                            provider: {
                                ...provider,
                                remoteName: 'upstream',
                            },
                        };
                    }
                    return {
                        kind: 'resolved' as const,
                        agentId: 'scm.gitlab',
                        provider: {
                            id: 'scm.gitlab',
                            kind: 'gitlab',
                            displayName: 'GitLab',
                            baseUrl: 'https://gitlab.com',
                            nameWithOwner: 'happier-dev/fork',
                            remoteName: 'origin',
                        },
                    };
                },
                buildCompareUrl() {
                    return {
                        kind: 'unsupported' as const,
                    };
                },
            },
            cache: createPrStatusCache({ now: () => 1000 }),
            now: () => 1000,
        });

        expect(projected.hostingProvider).toMatchObject({
            kind: 'github',
            remoteName: 'upstream',
        });
    });

    it('uses the detected repository default branch when the current feature branch has no upstream', () => {
        const baseSnapshot = createSnapshot();
        const snapshot: ScmWorkingSnapshot = {
            ...baseSnapshot,
            repo: {
                ...baseSnapshot.repo,
                defaultBranch: 'release/2026',
            } as ScmWorkingSnapshot['repo'] & { defaultBranch: string },
            branch: {
                ...baseSnapshot.branch,
                upstream: null,
            },
        };
        const projected = projectPullRequestStatus({
            snapshot,
            registry: {
                ...createRegistry(),
                buildCompareUrl({ base, head }) {
                    return {
                        kind: 'resolved' as const,
                        url: `https://github.com/happier-dev/happier/compare/${base}...${head}`,
                    };
                },
            },
            cache: createPrStatusCache({ now: () => 1000 }),
            now: () => 1000,
        });

        expect(projected.pullRequestStatus).toMatchObject({
            headBranch: 'feature/pr-cache',
            baseBranch: 'release/2026',
            composeUrl: 'https://github.com/happier-dev/happier/compare/release/2026...feature/pr-cache',
        });
    });

    it('prefers the detected repository default branch over the current branch upstream', () => {
        const baseSnapshot = createSnapshot();
        const snapshot: ScmWorkingSnapshot = {
            ...baseSnapshot,
            repo: {
                ...baseSnapshot.repo,
                defaultBranch: 'trunk',
            } as ScmWorkingSnapshot['repo'] & { defaultBranch: string },
            branch: {
                ...baseSnapshot.branch,
                upstream: 'origin/feature/pr-cache',
            },
        };
        const projected = projectPullRequestStatus({
            snapshot,
            registry: {
                ...createRegistry(),
                buildCompareUrl({ base, head }) {
                    return {
                        kind: 'resolved' as const,
                        url: `https://github.com/happier-dev/happier/compare/${base}...${head}`,
                    };
                },
            },
            cache: createPrStatusCache({ now: () => 1000 }),
            now: () => 1000,
        });

        expect(projected.pullRequestStatus).toMatchObject({
            headBranch: 'feature/pr-cache',
            baseBranch: 'trunk',
            composeUrl: 'https://github.com/happier-dev/happier/compare/trunk...feature/pr-cache',
        });
    });
});
