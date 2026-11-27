import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type {
  HostingProviderPullRequestsCapability,
  ScmHostingProviderRef } from '@happier-dev/plugin-sdk/scm/hosting';
import type {
  ScmPullRequestSummary,
  ScmWorkingSnapshot,
} from '@happier-dev/plugin-sdk/scm';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/scm';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ScmNativeOperationRefusalSchema } from '@happier-dev/protocol/scm/operationError';
import { createScmBackendRegistry } from '@/scm/registry';
import { runWithScmRequesterCredentials } from '@/scm/accountScope';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { createTestGitScmBackendRegistry, createTestRpcManager } from '@/scm/rpc/__tests__/testRpcHarness';

import type { ScmBackendContext } from '../types.js';
import { createPrStatusCache } from '../hostingProviders/prStatusCache.js';
import { createGitScmBackendRuntimeRegistration } from '../backend.js';
import { createGitPullRequestReadOperations } from './pullRequestReadOperations.js';
import { createGithubRestAdapter } from '../../../scm-github/src/pullRequests/restAdapter.js';
import { createGithubForgeHttpFixture } from '../../../../../apps/cli/src/testkit/scm/githubForgeHttp';
import { createRealGitScmBackendRuntimeServices, runWithGitScmCommandRunner } from '../testkit/scmRuntime.test-support.js';

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
        detectRemote: () => ({ kind: 'resolved' as const, providerId: provider.id, provider }),
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
    it('returns unsupported for a local repository without remotes even when hosting inventory is unavailable', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-compose-local-'));
        try {
            execFileSync('git', ['init', '--quiet'], { cwd: root });
            const localContext = { ...context, cwd: root, detection: { ...context.detection, rootPath: root } };
            // Install only the OS/Git boundary. No hosting service exists for this local-only repository.
            await expect(runWithGitScmCommandRunner(createRealGitScmBackendRuntimeServices().runCommand,
                () => createGitPullRequestReadOperations().openCompose({ context: localContext,
                    request: { base: 'main', head: 'feature/local' } })))
                .resolves.toMatchObject({ success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED });
        } finally { await rm(root, { recursive: true, force: true }); }
    });

    it('returns the single-state typed failure in place while both sibling states succeed', async () => {
        const adapter = createGithubRestAdapter({
            resolveToken: async () => ({ kind: 'available', token: 'fixture' }),
            fetcher: async url => {
                const open = new URL(url).searchParams.get('state') === 'open';
                return {
                    ok: !open,
                    status: open ? 404 : 200,
                    statusText: open ? 'Not Found' : 'OK',
                    json: async () => [],
                    text: async () => open ? '{"message":"Not Found"}' : '[]',
                };
            },
        });
        const operations = createGitPullRequestReadOperations({
            registry: createRegistry(adapter), cache: createPrStatusCache(), readSnapshot: async () => createSnapshot(),
        });
        const states = ['closed', 'open', 'merged'] as const;
        const singleFailure = await operations.list({ context, request: { state: 'open' } });
        expect(singleFailure).toMatchObject({ success: false, errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND });

        await expect(operations.listStates({ context, request: { states } })).resolves.toEqual({
            results: [
                { ok: true, response: { success: true, pullRequests: [] } },
                { ok: false, error: singleFailure },
                { ok: true, response: { success: true, pullRequests: [] } },
            ],
        });
    });

    it('keeps an empty-message refusal from the auth-profile boundary as the same typed error as the single-state RPC', async () => {
        const cwd = await realpath(await mkdtemp(join(tmpdir(), 'happier-pr-state-refusal-')));
        try {
            execFileSync('git', ['init', '--quiet'], { cwd });
            const refusal = Object.assign(new Error(''), {
                errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE,
                actionErrorCode: 'agent_isolation_unavailable',
            });
            let authReads = 0;
            let refuseOnRead = 1;
            const operations = createGitPullRequestReadOperations({
                registry: createRegistry({
                    getPullRequestAuthProfileKey: () => {
                        if (++authReads === refuseOnRead) throw refusal;
                        return null;
                    },
                }),
                cache: createPrStatusCache(),
                readSnapshot: async () => createSnapshot(),
            });
            const [git] = createTestGitScmBackendRegistry().listBackends();
            const registry = createScmBackendRegistry([{
                ...git,
                pullRequestList: ({ request }) => operations.list({ context, request }),
            }]);
            const { call } = createTestRpcManager({ workingDirectory: cwd, registry });
            const singleFailure = await call(RPC_METHODS.SCM_PULL_REQUEST_LIST, { cwd, state: 'open' });
            expect(ScmNativeOperationRefusalSchema.parse(singleFailure)).toEqual({
                success: false,
                error: '',
                errorCode: refusal.errorCode,
                actionErrorCode: refusal.actionErrorCode,
            });

            authReads = 0;
            refuseOnRead = 2;
            const states = ['closed', 'open', 'merged'] as const;
            const { results } = await operations.listStates({ context, request: { states } });
            expect(results).toEqual([
                { ok: true, response: { success: true, pullRequests: [] } },
                { ok: false, error: singleFailure },
                { ok: true, response: { success: true, pullRequests: [] } },
            ]);
        } finally {
            await rm(cwd, { recursive: true, force: true });
        }
    });

    it('lists each state from the same checkout facts as standalone lists', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-pr-states-')));
        const main = join(root, 'main');
        const linked = join(root, 'linked');
        const detached = join(root, 'detached');
        const nonForge = join(root, 'non-forge');
        const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
        try {
            for (const cwd of [main, nonForge]) {
                git(root, 'init', '--quiet', '-b', 'trunk', cwd);
                git(cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-m', 'base');
            }
            const nameWithOwner = 'example/state-parity';
            const cloneUrl = `https://github.com/${nameWithOwner}.git`;
            git(main, 'remote', 'add', 'origin', cloneUrl);
            git(main, 'update-ref', 'refs/remotes/origin/trunk', 'HEAD');
            git(main, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
            git(main, 'worktree', 'add', '-b', 'feature', linked);
            git(main, 'worktree', 'add', '--detach', detached);
            git(nonForge, 'remote', 'add', 'origin', 'https://example.test/anonymous/project.git');
            const forge = createGithubForgeHttpFixture({ nameWithOwner, cloneUrl, listPullRequests: query => {
                if (query.get('state') === 'open') return [];
                const head = query.get('head');
                if (head !== 'example:feature' && head !== 'example:trunk') return [];
                const number = head === 'example:feature' ? 2 : 1;
                return [{ ...pullRequest, provider: forge.provider, state: 'closed', number,
                    url: `https://github.com/${nameWithOwner}/pull/${number}`,
                    baseBranch: 'trunk', headBranch: head.slice('example:'.length) }];
            } });
            const states = ['open', 'closed', 'merged'] as const;
            const createOperations = () => createGitPullRequestReadOperations({
                registry: forge.hosting, cache: createPrStatusCache(), runtimeServices: {},
            });
            const run = createRealGitScmBackendRuntimeServices().runCommand;
            for (const [cwd, expected] of [[main, 1], [linked, 2], [detached, 'INVALID_REQUEST'],
                [nonForge, 'FEATURE_UNSUPPORTED']] as const) {
                const checkout = { ...context, cwd, projectKey: cwd, detection: { ...context.detection, rootPath: cwd } };
                const ordinary = createOperations();
                let launches = 0;
                const count: typeof run = async command => {
                    launches += 1;
                    return run(command);
                };
                const independent = await runWithGitScmCommandRunner(count, () => Promise.all(
                    states.map(state => ordinary.list({ context: checkout, request: { state } }))));
                const independentLaunches = launches;
                launches = 0;
                const batch = await runWithGitScmCommandRunner(count, () => createOperations().listStates({
                    context: checkout, request: { states },
                }));
                expect(launches).toBeGreaterThan(0);
                expect(independentLaunches).toBe(states.length * launches);
                expect(JSON.stringify(batch.results)).toBe(JSON.stringify(independent.map(response => response.success
                    ? { ok: true, response } : { ok: false, error: response })));
                if (typeof expected === 'number') {
                    expect(independent).toMatchObject([
                        { success: true, pullRequests: [] },
                        { success: true, pullRequests: [{ number: expected, baseBranch: 'trunk' }] },
                        { success: true, pullRequests: [{ number: expected, baseBranch: 'trunk' }] },
                    ]);
                } else {
                    expect(independent).toEqual(states.map(() => expect.objectContaining({ success: false, errorCode: expected })));
                }
            }
            // The non-main default branch came from the checkout, with no branch metadata fetch.
            expect(forge.httpRequests.length).toBeGreaterThan(0);
            expect(forge.httpRequests.every(request => request.path.endsWith('/pulls'))).toBe(true);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('projects a local owner’s authenticated draft list into the next snapshot without exposing it to a guest', async () => {
        const cwd = await realpath(await mkdtemp(join(tmpdir(), 'happier-pr-draft-')));
        const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
        try {
            git('init', '--quiet', '-b', 'topic');
            git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-m', 'base');
            const nameWithOwner = 'example/private-draft';
            const cloneUrl = `https://github.com/${nameWithOwner}.git`;
            git('remote', 'add', 'origin', cloneUrl);
            git('update-ref', 'refs/remotes/origin/main', 'HEAD');
            git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
            const forge = createGithubForgeHttpFixture({ nameWithOwner, cloneUrl });
            forge.setPullRequest({
                ...pullRequest, provider: forge.provider, number: 1, state: 'draft', headBranch: 'topic',
                url: `https://github.com/${nameWithOwner}/pull/1`,
            });
            const registration = createGitScmBackendRuntimeRegistration();
            const runtime = registration.runtime!;
            const backend = createRegisteredScmBackendAdapter({
                definition: { id: registration.id, kind: 'git' },
                qualifiedId: `happier.scm.backend.git:${registration.id}`,
                executableDefinition: { repoModes: runtime.repoModes, capabilities: runtime.capabilities, commands: runtime.commands },
                registration,
                hostingProviderRuntimeServices: { resolveScmHostingProviderRegistry: async () => forge.hosting },
            });
            const { call } = createTestRpcManager({ workingDirectory: cwd, registry: createScmBackendRegistry([backend]) });
            const snapshot = () => call(RPC_METHODS.SCM_STATUS_SNAPSHOT, {});
            const noObservation = { success: true, snapshot: { pullRequestStatus: { openPullRequest: null, authState: 'unknown' } } };
            await expect(snapshot()).resolves.toMatchObject(noObservation);
            await expect(call(RPC_METHODS.SCM_PULL_REQUEST_LIST, { head: 'topic', state: 'open' })).resolves.toMatchObject({
                success: true, pullRequests: [{ number: 1, state: 'draft' }],
            });
            const observed = {
                success: true, snapshot: { pullRequestStatus: {
                    authState: 'authenticated', openPullRequest: { number: 1, state: 'draft' },
                } },
            };
            await expect(call(RPC_METHODS.SCM_STATUS_SNAPSHOT, { detail: 'facts' })).resolves.toMatchObject(observed);
            await expect(snapshot()).resolves.toMatchObject(observed);
            await runWithScmRequesterCredentials({ account: null, signal: new AbortController().signal },
                async () => await expect(snapshot()).resolves.toMatchObject(noObservation));
            expect(forge.httpRequests).toEqual([{ method: 'GET', path: `/repos/${nameWithOwner}/pulls` }]);
            expect(forge.tokenRequests()).toBe(1);
        } finally {
            await rm(cwd, { recursive: true, force: true });
        }
    });

    it('retains the forge throttle through list and get without another HTTP read', async () => {
        const fetcher = vi.fn(async () => ({
            ok: false, status: 403, statusText: 'Forbidden',
            headers: new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1900000000' }),
            json: async () => ({ message: 'API rate limit exceeded.' }),
            text: async () => 'API rate limit exceeded.',
        }));
        const adapter = createGithubRestAdapter({
            resolveToken: async () => ({ kind: 'available', token: 'fixture-token', profileKey: 'bound' }),
            fetcher,
        });
        const operations = createGitPullRequestReadOperations({
            registry: createRegistry(adapter), cache: createPrStatusCache(),
            readSnapshot: async () => createSnapshot(),
        });
        const expected = { success: false, errorCode: 'REMOTE_RATE_LIMITED', retryNotBeforeMs: 1900000000000 };
        expect(await operations.list({ context, request: {} })).toMatchObject(expected);
        const subsequent = await operations.get({ context, request: { prReference: { number: 42 } } });
        expect(subsequent).toMatchObject({ success: false, errorCode: 'REMOTE_RATE_LIMITED' });
        // The request owner parks the HTTP boundary using whole-second Retry-After;
        // its next refusal may round later, but must not permit an earlier retry.
        expect(subsequent.success ? undefined : subsequent.retryNotBeforeMs).toBeGreaterThanOrEqual(expected.retryNotBeforeMs);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
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

    it('discovers PRs across bases when only a head branch is requested', async () => {
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
        expect(observedBase).toBeUndefined();
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
