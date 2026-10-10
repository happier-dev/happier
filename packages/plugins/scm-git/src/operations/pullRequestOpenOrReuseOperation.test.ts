import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  SCM_OPERATION_ERROR_CODES,
  type ScmPullRequestOpenOrReuseRequest,
  type ScmPullRequestSummary,
  type ScmWorkingSnapshot,
} from '@happier-dev/plugin-sdk/scm';
import {
  type HostingProviderPullRequestsCapability,
  type ScmHostingProviderRef } from '@happier-dev/plugin-sdk/scm/hosting';

import type { ScmBackendContext } from '../types.js';
import { createPrStatusCache } from '../hostingProviders/prStatusCache.js';
import { createGitPullRequestOpenOrReuseOperation as createOperation } from './pullRequestOpenOrReuseOperation.js';
import { createEmptyScmHostingProviderRegistry, runWithGitScmCommandRunner, runWithRealGitScmRuntime } from '../testkit/scmRuntime.test-support.js';
import { createGithubRestAdapter } from '../../../scm-github/src/pullRequests/restAdapter.js';

function createGitPullRequestOpenOrReuseOperation(...args: Parameters<typeof createOperation>) {
    const operation = createOperation(...args);
    return {
        ...operation,
        openOrReuse(input: Parameters<typeof operation.openOrReuse>[0]) {
            // Provider-boundary cases use a synthetic empty repository; real-template cases
            // below retain the managed real Git runtime and its committed object database.
            if (input.context.cwd !== '/repo') return operation.openOrReuse(input);
            return runWithGitScmCommandRunner(async (command) => ({
                success: true, exitCode: 0, stderr: '',
                stdout: command.args[0] === 'rev-parse' ? 'a'.repeat(40) : '',
            }), () => operation.openOrReuse(input));
        },
    };
}

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
        headRepositoryNameWithOwner: 'happier-dev/happier',
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

function createRegistry(adapter: Partial<HostingProviderPullRequestsCapability>, hostingProvider = provider) {
    const capability: HostingProviderPullRequestsCapability | undefined = Object.keys(adapter).length === 0
        ? undefined
        : {
            getPullRequestAuthProfileKey: () => null,
            listPullRequests: async () => [],
            getPullRequest: async () => null,
            createPullRequest: async () => {
                throw new Error('Pull request creation is not configured by this fixture');
            },
            ...adapter,
        };
    return {
        getPullRequests(id: string) {
            return id === hostingProvider.id ? capability : undefined;
        },
        buildCompareUrl() {
            return {
                kind: 'resolved' as const,
                url: 'https://github.com/happier-dev/happier/compare/main...feature/scm-pr-6',
            };
        },
    };
}

function templateHostingServices(adapter: Partial<HostingProviderPullRequestsCapability>, hostingProvider = provider) {
    // The host service is outside this plugin's process boundary. Repository
    // inspection, status projection and template discovery below remain real.
    return {
        resolveScmHostingProviderRegistry: async () => ({
            ...createEmptyScmHostingProviderRegistry(),
            ...createRegistry(adapter, hostingProvider),
            detectRemote: () => ({ kind: 'resolved' as const, providerId: hostingProvider.id, provider: hostingProvider }),
        }),
    };
}

function configureLocalTrackingRefs(git: (args: string[]) => string, hostingProvider = provider) {
    git(['remote', 'add', 'origin', `${hostingProvider.baseUrl}/${hostingProvider.nameWithOwner}.git`]);
    git(['update-ref', 'refs/remotes/origin/feature/scm-pr-6', 'HEAD']);
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
    git(['branch', '--set-upstream-to=origin/feature/scm-pr-6']);
}

async function runWithRealPullRequestRepository(adapter: Partial<HostingProviderPullRequestsCapability>, request: ScmPullRequestOpenOrReuseRequest) {
    const root = await mkdtemp(join(tmpdir(), 'happier-pr-effect-'));
    try {
        const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
        git(['init', '-b', 'main']);
        git(['-c', 'user.name=PR test', '-c', 'user.email=pr@example.com', 'commit', '--allow-empty', '-m', 'base']);
        git(['checkout', '-b', 'feature/scm-pr-6']);
        configureLocalTrackingRefs(git);
        const operation = createGitPullRequestOpenOrReuseOperation();
        return await runWithRealGitScmRuntime(() => operation.openOrReuse({
            context: { ...context, cwd: root, detection: { ...context.detection, rootPath: root } }, request,
        }), { hostingProviderRuntimeServices: templateHostingServices(adapter) });
    } finally { await rm(root, { recursive: true, force: true }); }
}

describe('git pull request open-or-reuse operation', () => {
    it('retains a real forge creation throttle as a definite non-effect with the exact retry instant', async () => {
        const adapter = createGithubRestAdapter({
            resolveToken: async () => ({ kind: 'available', token: 'fixture-token' }),
            fetcher: async (_url, init) => {
                const throttled = init?.method === 'POST';
                return {
                    ok: !throttled, status: throttled ? 403 : 200, statusText: throttled ? 'Forbidden' : 'OK',
                    headers: new Headers(throttled ? { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1900000000' } : {}),
                    json: async () => throttled ? { message: 'API rate limit exceeded.' } : [],
                    text: async () => '',
                };
            },
        });
        expect(await runWithRealPullRequestRepository(adapter, { base: 'main', body: '' })).toMatchObject({
            success: false, errorCode: 'REMOTE_RATE_LIMITED', retryNotBeforeMs: 1900000000000,
        });
    });
    it('retains a provider pre-effect validation as actionable input rather than an unknown creation', async () => {
        const error = Object.assign(new Error('Choose a valid provider input'), { errorCode: 'INVALID_REQUEST', effectNotApplied: true });
        await expect(runWithRealPullRequestRepository({ createPullRequest: async () => { throw error; } },
            { base: 'main', body: '' })).resolves.toMatchObject({
            success: false, errorCode: 'INVALID_REQUEST', outcome: { kind: 'needs_input', errorCode: 'INVALID_REQUEST' },
        });
    });

    it('reports an unknown outward outcome when creation loses transport and lookup cannot prove the effect', async () => {
        await expect(runWithRealPullRequestRepository({
                listPullRequests: vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('Network unavailable')),
                createPullRequest: async () => { throw new Error('Connection lost after submission'); },
            }, { base: 'main', body: '' })).resolves.toMatchObject({
            success: false,
            outcome: {
                kind: 'outcome_unknown',
                reconciliation: { kind: 'pull_request', providerId: provider.id, repository: provider.nameWithOwner, head: 'feature/scm-pr-6', base: 'main' },
            },
        });
    });

    it.each([
        ['ambiguous', ['.github/PULL_REQUEST_TEMPLATE/bug.md', '.github/PULL_REQUEST_TEMPLATE/feature.md'], 'Body'],
        ['binary', ['.github/PULL_REQUEST_TEMPLATE.md'], 'Unsafe\0body'],
        ['large valid', ['.github/PULL_REQUEST_TEMPLATE.md'], 'Valid template\n'.repeat(6000)],
    ])('preserves %s committed template semantics before creating a PR', async (scenario, paths, body) => {
        const root = await mkdtemp(join(tmpdir(), 'happier-pr-template-'));
        try {
            const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
            git(['init', '-b', 'main']);
            for (const path of paths) {
                await mkdir(dirname(join(root, path)), { recursive: true });
                await writeFile(join(root, path), body);
            }
            git(['add', '.']);
            git(['-c', 'user.name=Template test', '-c', 'user.email=template@example.com', 'commit', '-m', 'base']);
            git(['checkout', '-b', 'feature/scm-pr-6']);
            configureLocalTrackingRefs(git);
            const create = vi.fn(async (_input: Parameters<HostingProviderPullRequestsCapability['createPullRequest']>[0]) => createPullRequest());
            const operation = createGitPullRequestOpenOrReuseOperation();
            const result = await runWithRealGitScmRuntime(() => operation.openOrReuse({
                context: { ...context, cwd: root, detection: { ...context.detection, rootPath: root } }, request: { base: 'main' },
            }), { hostingProviderRuntimeServices: templateHostingServices({ createPullRequest: create }) });
            if (scenario === 'large valid') {
                expect(result.success).toBe(true);
                expect(create.mock.calls[0]?.[0].body === body).toBe(true);
            } else {
                expect(result).toMatchObject({ success: false, outcome: { kind: 'needs_input', errorCode: 'INVALID_REQUEST' } });
                expect(create).not.toHaveBeenCalled();
            }
        } finally { await rm(root, { recursive: true, force: true }); }
    });

    it.each([
        ['github', '.github/PULL_REQUEST_TEMPLATE.md'],
        ['github', 'docs/pull_request_template.md'],
        ['gitlab', '.gitlab/merge_request_templates/Default.md'],
    ])('seeds %s creation from the committed base template at %s', async (kind, templatePath) => {
        const root = await mkdtemp(join(tmpdir(), 'happier-pr-template-'));
        try {
            const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
            git(['init', '-b', 'main']);
            await mkdir(dirname(join(root, templatePath)), { recursive: true });
            await writeFile(join(root, templatePath), 'Base template\n');
            git(['add', '.']);
            git(['-c', 'user.name=Template test', '-c', 'user.email=template@example.com', 'commit', '-m', 'base']);
            git(['checkout', '-b', 'feature/scm-pr-6']);
            await writeFile(join(root, templatePath), 'Uncommitted feature template\n');
            const hostingProvider = { ...provider, id: `scm.${kind}`, kind,
                ...(kind === 'gitlab' ? { baseUrl: 'https://gitlab.com', repositoryWebUrl: 'https://gitlab.com/happier-dev/happier' } : {}) };
            configureLocalTrackingRefs(git, hostingProvider);
            const localContext = { ...context, cwd: root, detection: { ...context.detection, rootPath: root } };
            const create = vi.fn(async (_input: Parameters<NonNullable<HostingProviderPullRequestsCapability['createPullRequest']>>[0]) => createPullRequest({ provider: hostingProvider,
                ...(kind === 'gitlab' ? { url: 'https://gitlab.com/happier-dev/happier/-/merge_requests/42' } : {}) }));
            const operation = createGitPullRequestOpenOrReuseOperation();
            const runtimeOptions = { hostingProviderRuntimeServices: templateHostingServices({ supportsDraftCreate: true, createPullRequest: create }, hostingProvider) };
            await runWithRealGitScmRuntime(() => operation.openOrReuse({
                context: localContext, request: { base: 'main', draft: true },
            }), runtimeOptions);
            expect(create.mock.calls[0]?.[0]).toMatchObject({ body: 'Base template\n', draft: true, base: 'main', head: 'feature/scm-pr-6' });
            await runWithRealGitScmRuntime(() => operation.openOrReuse({
                context: localContext, request: { base: 'main', body: '' },
            }), runtimeOptions);
            expect(create.mock.calls[1]?.[0]).toMatchObject({ body: '' });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('resolves default hosting provider runtime services from the host only', () => {
        const source = readFileSync(new URL('./pullRequestOpenOrReuseOperation.ts', import.meta.url), 'utf8');

        expect(source).not.toContain('../hostingProviders/runtimeServices');
        expect(source).not.toContain('createScmHostingProviderRuntimeServices');
    });

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
                supportsDraftCreate: true,
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
                draft: true,
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
        expect(createPullRequestHook).toHaveBeenCalledWith(expect.objectContaining({ draft: true }));
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
            success: false,
            outcome: { kind: 'needs_input', nextActions: [{ kind: 'open_url', url: 'https://github.com/happier-dev/happier/compare/main...feature/scm-pr-6' }] },
            pullRequest: null,
            reused: false,
            composeUrl: 'https://github.com/happier-dev/happier/compare/main...feature/scm-pr-6',
            nextAction: {
                kind: 'openUrl',
                purpose: 'compose',
                url: 'https://github.com/happier-dev/happier/compare/main...feature/scm-pr-6',
                allowedBaseUrl: 'https://github.com/happier-dev/happier',
            },
            authState: 'authentication_required',
        });
    });

    it('uses the provider compose page instead of silently creating a non-draft PR when the adapter lacks Draft support', async () => {
        const createPullRequest = vi.fn();
        const operation = createGitPullRequestOpenOrReuseOperation({
            cache: createPrStatusCache({ now: () => 1000 }),
            registry: createRegistry({ createPullRequest }),
            readSnapshot: async () => createSnapshot(),
            now: () => 1000,
        });
        await expect(operation.openOrReuse({
            context, request: { cwd: '/repo', base: 'main', title: 'Draft PR', draft: true },
        })).resolves.toMatchObject({ success: false, outcome: { kind: 'needs_input' }, pullRequest: null, nextAction: { kind: 'openUrl', purpose: 'compose' } });
        expect(createPullRequest).not.toHaveBeenCalled();
    });

    it('does not return an openUrl follow-up when the provider PR URL escapes the allowed base URL', async () => {
        const unsafePullRequest = createPullRequest({
            url: 'https://evil.example.com/happier-dev/happier/pull/42',
        });
        const operation = createGitPullRequestOpenOrReuseOperation({
            cache: createPrStatusCache({ now: () => 1000 }),
            registry: createRegistry({
                listPullRequests: async () => [unsafePullRequest],
                createPullRequest: async () => unsafePullRequest,
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
            pullRequest: unsafePullRequest,
            nextAction: { kind: 'none' },
        });
    });

    it('rejects created pull requests outside the resolved provider repository context', async () => {
        const wrongRepositoryPullRequest = createPullRequest({
            provider: {
                ...provider,
                nameWithOwner: 'other/repo',
            },
            url: 'https://github.com/other/repo/pull/42',
        });
        const cache = createPrStatusCache({ now: () => 1000 });
        const operation = createGitPullRequestOpenOrReuseOperation({
            cache,
            registry: createRegistry({
                listPullRequests: async () => [],
                createPullRequest: vi.fn(async () => wrongRepositoryPullRequest),
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
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
        });
        expect(cache.getFresh({
            workspaceKey: context.projectKey,
            repoRootPath: '/repo',
            provider,
            baseBranch: 'main',
            headBranch: 'feature/scm-pr-6',
            state: 'open',
        })).toBeNull();
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

    it('reuses fork pull requests only when the requested head repository context matches', async () => {
        const forkPullRequest = createPullRequest({
            headRepositoryNameWithOwner: 'someone/happier-fork',
            isCrossRepository: true,
        });
        const listPullRequests = vi.fn(async () => [forkPullRequest]);
        const createPullRequestHook = vi.fn();
        const operation = createGitPullRequestOpenOrReuseOperation({
            cache: createPrStatusCache({ now: () => 1000 }),
            registry: createRegistry({
                listPullRequests,
                createPullRequest: createPullRequestHook,
            }),
            readSnapshot: async () => createSnapshot(),
            now: () => 1000,
        });
        const request = {
            cwd: '/repo',
            base: 'main',
            title: 'Open PR',
            headRepositoryNameWithOwner: 'someone/happier-fork',
        } satisfies ScmPullRequestOpenOrReuseRequest & { headRepositoryNameWithOwner: string };

        await expect(operation.openOrReuse({ context, request })).resolves.toMatchObject({
            success: true,
            reused: true,
            pullRequest: forkPullRequest,
        });
        expect(createPullRequestHook).not.toHaveBeenCalled();
    });

    it('does not reuse duplicate hints from a different head fork repository', async () => {
        const wrongForkHint = createPullRequest({
            number: 99,
            url: 'https://github.com/happier-dev/happier/pull/99',
            headRepositoryNameWithOwner: 'someone-else/happier-fork',
            isCrossRepository: true,
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
                    .mockResolvedValueOnce([]),
                getPullRequest: vi.fn(async () => wrongForkHint),
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
                headRepositoryNameWithOwner: 'someone/happier-fork',
            },
        })).resolves.toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_ALREADY_EXISTS,
        });
    });

    it('returns the original duplicate error when invalid hint recovery cannot list open PRs', async () => {
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
                    .mockRejectedValueOnce(new Error('follow-up list failed')),
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
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_ALREADY_EXISTS,
        });
    });

    it('writes successful create results under the post-call auth profile key', async () => {
        const cache = createPrStatusCache({ now: () => 1000 });
        const pullRequest = createPullRequest();
        let authProfileKey: string | null = null;
        const operation = createGitPullRequestOpenOrReuseOperation({
            cache,
            registry: createRegistry({
                getPullRequestAuthProfileKey: () => authProfileKey,
                listPullRequests: async () => [],
                createPullRequest: async () => {
                    authProfileKey = 'github:work';
                    return pullRequest;
                },
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
        })).resolves.toMatchObject({ success: true, reused: false });

        expect(cache.getFresh({
            workspaceKey: context.projectKey,
            repoRootPath: '/repo',
            provider,
            baseBranch: 'main',
            headBranch: 'feature/scm-pr-6',
            state: 'open',
            authProfileKey: 'github:work',
        })).toMatchObject({ kind: 'success', pullRequests: [pullRequest] });
        expect(cache.getFresh({
            workspaceKey: context.projectKey,
            repoRootPath: '/repo',
            provider,
            baseBranch: 'main',
            headBranch: 'feature/scm-pr-6',
            state: 'open',
        })).toBeNull();
    });

    it('does not reuse or publish auth-sensitive open PR rows without a safe auth identity key', async () => {
        const cache = createPrStatusCache({ now: () => 1000 });
        const priorPullRequest = createPullRequest({
            number: 41,
            title: 'Prior account row',
            url: 'https://github.com/happier-dev/happier/pull/41',
        });
        const currentPullRequest = createPullRequest();
        cache.setSuccess({
            key: {
                workspaceKey: context.projectKey,
                repoRootPath: '/repo',
                provider,
                baseBranch: 'main',
                headBranch: 'feature/scm-pr-6',
                state: 'open',
            },
            pullRequests: [priorPullRequest],
        });
        const listPullRequests = vi.fn(async () => [currentPullRequest]);
        const operation = createGitPullRequestOpenOrReuseOperation({
            cache,
            registry: createRegistry({
                getPullRequestAuthProfileKey: () => null,
                listPullRequests,
                createPullRequest: vi.fn(),
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
            pullRequest: currentPullRequest,
        });
        expect(listPullRequests).toHaveBeenCalledOnce();
        expect(cache.getFresh({
            workspaceKey: context.projectKey,
            repoRootPath: '/repo',
            provider,
            baseBranch: 'main',
            headBranch: 'feature/scm-pr-6',
            state: 'open',
        })).toMatchObject({
            kind: 'success',
            pullRequests: [priorPullRequest],
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

    it('honors request-scoped default-branch policy before publishing or creating a PR', async () => {
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
                capabilities: {
                    capabilityScope: 'local-backend',
                    defaultBranchPushPolicy: 'deny',
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
                defaultBranchPushPolicy: 'requires-feature-branch',
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

    it('blocks explicit base-to-base heads even when another branch is active', async () => {
        const createdPullRequest = createPullRequest();
        const createPullRequestHook = vi.fn(async () => createdPullRequest);
        const operation = createGitPullRequestOpenOrReuseOperation({
            cache: createPrStatusCache({ now: () => 1000 }),
            registry: createRegistry({
                listPullRequests: async () => [],
                createPullRequest: createPullRequestHook,
            }),
            readSnapshot: async () => createSnapshot({
                branch: {
                    head: 'feature/scm-pr-6',
                    upstream: 'origin/feature/scm-pr-6',
                    ahead: 1,
                    behind: 0,
                    detached: false,
                },
            }),
            now: () => 1000,
        });

        const response = await operation.openOrReuse({
            context,
            request: {
                cwd: '/repo',
                base: 'main',
                head: 'main',
                title: 'Do not open main against itself',
            },
        });

        expect(response).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
        });
        expect(createPullRequestHook).not.toHaveBeenCalled();
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
