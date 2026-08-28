import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import type {
  HostingProviderPullRequestsCapability,
  ScmHostingProviderRef } from '@happier-dev/plugin-sdk/scm/hosting';
import type {
  ScmPullRequestSummary,
  ScmWorkingSnapshot,
} from '@happier-dev/plugin-sdk/scm';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/scm';

import type { ScmBackendContext } from '../types.js';
import { createPrStatusCache } from '../hostingProviders/prStatusCache.js';
import { createGitPullRequestReadOperations } from './pullRequestReadOperations.js';

const provider: ScmHostingProviderRef = {
    id: 'scm.github',
    kind: 'github',
    displayName: 'GitHub',
    baseUrl: 'https://github.com',
    nameWithOwner: 'happier-dev/happier',
    repositoryWebUrl: 'https://github.com/happier-dev/happier',
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

function createRegistry(adapter: Partial<HostingProviderPullRequestsCapability>, input?: Readonly<{
    compareUrl?: string;
}>) {
    const capability: HostingProviderPullRequestsCapability | undefined = Object.keys(adapter).length === 0
        ? undefined
        : {
            getPullRequestAuthProfileKey: () => null,
            listPullRequests: async () => [],
            getPullRequest: async () => null,
            createPullRequest: async () => {
                throw new Error('Pull request creation is not used by this read-operation fixture');
            },
            ...adapter,
        };
    return {
        getPullRequests(id: string) {
            return id === provider.id ? capability : undefined;
        },
        buildCompareUrl() {
            return {
                kind: 'resolved' as const,
                url: input?.compareUrl ?? 'https://github.com/happier-dev/happier/compare/main...feature/pr-cache',
            };
        },
    };
}

describe('git pull request read operations', () => {
    it('resolves default hosting provider runtime services from the host only', () => {
        const source = readFileSync(new URL('./pullRequestReadOperations.ts', import.meta.url), 'utf8');

        expect(source).not.toContain('../hostingProviders/runtimeServices');
        expect(source).not.toContain('createScmHostingProviderRuntimeServices');
    });

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
        const runtimeServices = {
            resolveScmHostingBasicAuthMaterialization: async () => ({ kind: 'unavailable' as const }),
            resolveScmHostingTokenMaterialization: async () => ({ kind: 'unavailable' as const }),
            resolveInstallableCommand: async () => ({ kind: 'missing' as const }),
            runCommand: async () => ({ ok: false, stdout: '', stderr: '', exitCode: null }),
        };
        const operations = createGitPullRequestReadOperations({
            cache: createPrStatusCache({ now: () => 1000 }),
            registry: createRegistry({
                listPullRequests: async (input: Readonly<{ runtimeServices?: unknown }>) => {
                    observedRuntimeServices = input.runtimeServices ?? null;
                    return [pullRequest];
                },
            }),
            runtimeServices,
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
        expect(observedRuntimeServices).toBe(runtimeServices);
    });

    it('uses the detected repository default branch before current upstream when list base is omitted', async () => {
        let observedBase: string | undefined;
        const operations = createGitPullRequestReadOperations({
            cache: createPrStatusCache({ now: () => 1000 }),
            registry: createRegistry({
                listPullRequests: async (input: Readonly<{ base?: string }>) => {
                    observedBase = input.base;
                    return [pullRequest];
                },
            }),
            readSnapshot: async () => {
                const snapshot = createSnapshot();
                return {
                    ...snapshot,
                    repo: {
                        ...snapshot.repo,
                        defaultBranch: 'trunk',
                    },
                    branch: {
                        ...snapshot.branch,
                        upstream: 'origin/feature/pr-cache',
                    },
                };
            },
            now: () => 1000,
        });

        const response = await operations.list({
            context,
            request: {
                cwd: '/repo',
                head: 'feature/pr-cache',
                state: 'open',
            },
        });

        expect(response.success).toBe(true);
        expect(observedBase).toBe('trunk');
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

    it('does not reuse or publish auth-sensitive PR rows without a safe auth identity key', async () => {
        const cache = createPrStatusCache({ now: () => 1000 });
        const priorPullRequest = {
            ...pullRequest,
            number: 41,
            title: 'Prior account row',
            url: 'https://github.com/happier-dev/happier/pull/41',
        };
        cache.setSuccess({
            key: {
                workspaceKey: context.projectKey,
                repoRootPath: '/repo',
                provider,
                baseBranch: 'main',
                headBranch: 'feature/pr-cache',
                state: 'open',
            },
            pullRequests: [priorPullRequest],
        });
        const listPullRequests = vi.fn(async () => [pullRequest]);
        const operations = createGitPullRequestReadOperations({
            cache,
            registry: createRegistry({
                getPullRequestAuthProfileKey: () => null,
                listPullRequests,
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
        })).resolves.toMatchObject({
            success: true,
            pullRequests: [pullRequest],
        });
        expect(listPullRequests).toHaveBeenCalledOnce();
        expect(cache.getFresh({
            workspaceKey: context.projectKey,
            repoRootPath: '/repo',
            provider,
            baseBranch: 'main',
            headBranch: 'feature/pr-cache',
            state: 'open',
        })).toMatchObject({
            kind: 'success',
            pullRequests: [priorPullRequest],
        });
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
                allowedBaseUrl: 'https://github.com/happier-dev/happier',
                urlSafety: { allowedSchemes: ['https:'] },
            },
        });
        expect(listPullRequests).not.toHaveBeenCalled();
    });

    it('does not return open-url follow-up actions for unsafe compose URLs', async () => {
        const operations = createGitPullRequestReadOperations({
            cache: createPrStatusCache({ now: () => 1000 }),
            registry: createRegistry({}, { compareUrl: 'http://github.com/happier-dev/happier/compare/main...feature/pr-cache' }),
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
            composeUrl: 'http://github.com/happier-dev/happier/compare/main...feature/pr-cache',
            nextAction: { kind: 'none' },
        });
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

    it('uses the grouped exact-get result instead of guessing from the current head list for numeric references', async () => {
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

        expect(response).toEqual({ success: true, pullRequest: null });
    });

    it('uses the grouped exact-get result instead of guessing from the current head list for URL references', async () => {
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

        expect(response).toEqual({ success: true, pullRequest: null });
    });
});
