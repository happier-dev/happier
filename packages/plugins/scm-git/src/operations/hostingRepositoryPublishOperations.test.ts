import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import {
  SCM_OPERATION_ERROR_CODES,
  type ScmHostingRepositoryPublishRequest,
  type ScmHostingRepositorySummary,
  type ScmRemoteManagementResponse,
  type ScmRemotePublishResponse,
  type ScmWorkingSnapshot,
} from '@happier-dev/plugin-sdk/scm';
import {
  type ScmHostingProviderRef } from '@happier-dev/plugin-sdk/scm/hosting';
import { describe, expect, it, vi } from 'vitest';

import type { ScmBackendContext } from '../types.js';
import { runWithRealGitScmRuntime } from '../testkit/scmRuntime.test-support.js';
import { defaultPrStatusCache } from '../hostingProviders/prStatusCache.js';
import { createGitHostingRepositoryPublishOperation } from './hostingRepositoryPublishOperations.js';

const provider: ScmHostingProviderRef = {
    id: 'scm.github',
    kind: 'github',
    displayName: 'GitHub',
    baseUrl: 'https://github.com',
    urlSafety: { allowedSchemes: ['https:'] },
};

const repository: ScmHostingRepositorySummary = {
    provider,
    nameWithOwner: 'happier-dev/project',
    webUrl: 'https://github.com/happier-dev/project',
    cloneUrl: 'https://github.com/happier-dev/project.git',
    sshUrl: 'git@github.com:happier-dev/project.git',
    visibility: 'private',
    defaultBranch: 'main',
};

const context: ScmBackendContext = {
    cwd: '/workspace',
    projectKey: 'machine:/workspace',
    detection: {
        isRepo: true,
        rootPath: '/workspace',
        mode: '.git',
    },
};

function git(cwd: string, args: readonly string[]): string {
    return execFileSync('git', [...args], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

function gitExitStatus(cwd: string, args: readonly string[]): number {
    const result = spawnSync('git', [...args], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    return result.status ?? 1;
}

function publishWithRealGitRuntime(
    operation: ReturnType<typeof createGitHostingRepositoryPublishOperation>,
    input: Parameters<ReturnType<typeof createGitHostingRepositoryPublishOperation>['publish']>[0],
) {
    return runWithRealGitScmRuntime(() => operation.publish(input));
}

function snapshot(overrides: Partial<ScmWorkingSnapshot> = {}): ScmWorkingSnapshot {
    return {
        projectKey: context.projectKey,
        fetchedAt: 1000,
        repo: {
            isRepo: true,
            rootPath: '/workspace',
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
            writeHostingRepositoryPublish: true,
            worktreeCreate: true,
            changeSetModel: 'index',
            supportedDiffAreas: ['included', 'pending', 'both'],
        },
        branch: {
            head: 'feature/publish',
            upstream: null,
            ahead: 0,
            behind: 0,
            detached: false,
        },
        hostingProvider: provider,
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

function createRegistry(adapter: Readonly<Record<string, unknown>>) {
    return {
        providers: [{
            ...provider,
            capabilities: {},
        }],
        getAdapter(id: string) {
            return id === provider.id ? adapter : undefined;
        },
    };
}

function createMultiProviderRegistry(adapters: Readonly<Record<string, Readonly<Record<string, unknown>>>>) {
    const providerTwo: ScmHostingProviderRef = {
        ...provider,
        id: 'scm.github.enterprise',
        displayName: 'GitHub Enterprise',
        baseUrl: 'https://ghe.example.com',
    };
    return {
        providers: [
            { ...provider, capabilities: {} },
            { ...providerTwo, capabilities: {} },
        ],
        getAdapter(id: string) {
            return adapters[id];
        },
    };
}

function remoteSuccess(remoteUrl: string): ScmRemoteManagementResponse {
    return {
        success: true,
        remotes: [{
            name: 'origin',
            fetchUrl: remoteUrl,
            pushUrl: remoteUrl,
        }],
    };
}

function publishRequest(overrides: Partial<ScmHostingRepositoryPublishRequest> = {}): ScmHostingRepositoryPublishRequest {
    return {
        cwd: '/workspace',
        providerKind: 'github',
        owner: 'happier-dev',
        repositoryName: 'project',
        visibility: 'private',
        remoteName: 'origin',
        pushCurrentBranch: false,
        ...overrides,
    };
}

describe('git hosting repository publish operation', () => {
    it('resolves default hosting provider registries from host-injected runtime services only', () => {
        const source = readFileSync(new URL('./hostingRepositoryPublishOperations.ts', import.meta.url), 'utf8');

        expect(source).not.toContain('../hostingProviders/runtimeServices');
        expect(source).not.toContain('createScmHostingProviderRuntimeServices');
    });

    it('creates a hosting repository, adds the selected remote, and pushes the current branch through real Git primitives', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-hosting-publish-op-'));
        const bareRemote = mkdtempSync(join(tmpdir(), 'happier-git-hosting-publish-remote-'));
        git(bareRemote, ['init', '--bare']);
        git(workspace, ['init', '-b', 'main']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'README.md'), 'hello\n');
        git(workspace, ['add', 'README.md']);
        git(workspace, ['commit', '-m', 'initial']);
        git(workspace, ['checkout', '-b', 'feature/publish']);

        const repositoryWithLocalRemote: ScmHostingRepositorySummary = {
            ...repository,
            cloneUrl: bareRemote,
        };
        const operation = createGitHostingRepositoryPublishOperation({
            registry: createRegistry({
                createRepository: vi.fn(async () => repositoryWithLocalRemote),
            }),
        });

        const result = await publishWithRealGitRuntime(operation, {
            context: {
                cwd: workspace,
                projectKey: `test:${workspace}`,
                detection: {
                    isRepo: true,
                    rootPath: workspace,
                    mode: '.git',
                },
            },
            request: {
                cwd: '.',
                providerKind: 'github',
                owner: 'happier-dev',
                repositoryName: 'project',
                visibility: 'private',
                remoteName: 'origin',
                pushCurrentBranch: true,
            },
        });

        expect(result).toMatchObject({
            success: true,
            repository: repositoryWithLocalRemote,
            remote: {
                name: 'origin',
                fetchUrl: bareRemote,
                pushUrl: bareRemote,
            },
            pushed: true,
        });
        expect(git(workspace, ['remote', 'get-url', 'origin'])).toBe(bareRemote);
        expect(git(workspace, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).toBe('origin/feature/publish');
        expect(git(bareRemote, ['show-ref', '--verify', 'refs/heads/feature/publish'])).toContain('refs/heads/feature/publish');
    });

    it('reuses the selected remote when existing URLs already match the target repository', async () => {
        const createRepository = vi.fn(async () => repository);
        const remoteAdd = vi.fn();
        const remoteSetUrl = vi.fn();
        const remotePublish = vi.fn();
        const operation = createGitHostingRepositoryPublishOperation({
            registry: createRegistry({ createRepository }),
            readSnapshot: async () => snapshot({
                repo: {
                    ...snapshot().repo,
                    remotes: [{
                        name: 'origin',
                        fetchUrl: repository.cloneUrl!,
                        pushUrl: repository.cloneUrl!,
                    }],
                },
            }),
            hasCurrentCommit: async () => true,
            remoteAdd,
            remoteSetUrl,
            remotePublish,
        });

        const result = await publishWithRealGitRuntime(operation, {
            context,
            request: publishRequest(),
        });

        expect(result).toMatchObject({
            success: true,
            repository,
            remote: {
                name: 'origin',
                fetchUrl: repository.cloneUrl,
                pushUrl: repository.cloneUrl,
            },
            pushed: false,
        });
        expect(createRepository).toHaveBeenCalledTimes(1);
        expect(remoteAdd).not.toHaveBeenCalled();
        expect(remoteSetUrl).not.toHaveBeenCalled();
        expect(remotePublish).not.toHaveBeenCalled();
    });

    it('publishes through the concrete selected provider id when multiple providers share a kind', async () => {
        const githubCreate = vi.fn(async () => repository);
        const enterpriseRepository: ScmHostingRepositorySummary = {
            ...repository,
            provider: {
                ...provider,
                id: 'scm.github.enterprise',
                displayName: 'GitHub Enterprise',
                baseUrl: 'https://ghe.example.com',
            },
            webUrl: 'https://ghe.example.com/happier-dev/project',
            cloneUrl: 'https://ghe.example.com/happier-dev/project.git',
        };
        const enterpriseCreate = vi.fn(async () => enterpriseRepository);
        const operation = createGitHostingRepositoryPublishOperation({
            registry: createMultiProviderRegistry({
                [provider.id]: { createRepository: githubCreate },
                'scm.github.enterprise': { createRepository: enterpriseCreate },
            }),
            readSnapshot: async () => snapshot(),
            hasCurrentCommit: async () => true,
            remoteAdd: vi.fn(async () => remoteSuccess(enterpriseRepository.cloneUrl!)),
        });

        const result = await publishWithRealGitRuntime(operation, {
            context,
            request: publishRequest({ providerId: 'scm.github.enterprise' } as Partial<ScmHostingRepositoryPublishRequest>),
        });

        expect(result).toMatchObject({
            success: true,
            repository: enterpriseRepository,
        });
        expect(githubCreate).not.toHaveBeenCalled();
        expect(enterpriseCreate).toHaveBeenCalledTimes(1);
    });

    it('passes host-injected URL safety fences to repository publish adapters', async () => {
        const urlSafety = {
            allowedSchemes: ['https:', 'ssh:'],
            allowedBaseUrls: ['https://ghe.example.com/happier-dev/'],
            allowedOrigins: ['https://ghe.example.com'],
        } as const;
        const getRepository = vi.fn(async () => null);
        const createRepository = vi.fn(async () => repository);
        const operation = createGitHostingRepositoryPublishOperation({
            registry: {
                providers: [{
                    ...provider,
                    urlSafety,
                    capabilities: {},
                }],
                getAdapter(id: string) {
                    return id === provider.id ? { getRepository, createRepository } : undefined;
                },
            },
            readSnapshot: async () => snapshot(),
            hasCurrentCommit: async () => true,
            remoteAdd: vi.fn(async () => remoteSuccess(repository.cloneUrl!)),
        });

        const result = await publishWithRealGitRuntime(operation, {
            context,
            request: publishRequest(),
        });

        expect(result).toMatchObject({ success: true });
        expect(getRepository).toHaveBeenCalledWith(expect.objectContaining({
            provider: expect.objectContaining({ urlSafety }),
        }));
        expect(createRepository).toHaveBeenCalledWith(expect.objectContaining({
            provider: expect.objectContaining({ urlSafety }),
        }));
    });

    it('describes publish targets through the concrete selected provider id', async () => {
        const githubDescribe = vi.fn(async () => ({
            auth: { state: 'authenticated' as const, profileKind: 'connected_account' as const },
            targets: [],
        }));
        const enterpriseDescribe = vi.fn(async () => ({
            auth: { state: 'authenticated' as const, profileKind: 'provider_cli' as const },
            targets: [{
                provider: {
                    ...provider,
                    id: 'scm.github.enterprise',
                    displayName: 'GitHub Enterprise',
                    baseUrl: 'https://ghe.example.com',
                },
                owner: 'happier-dev',
                ownerKind: 'org' as const,
                label: 'happier-dev',
                supportedVisibilities: ['private' as const],
                supportedRemoteUrlKinds: ['https' as const],
            }],
        }));
        const operation = createGitHostingRepositoryPublishOperation({
            registry: createMultiProviderRegistry({
                [provider.id]: { describePublishTargets: githubDescribe },
                'scm.github.enterprise': { describePublishTargets: enterpriseDescribe },
            }),
        });

        const result = await runWithRealGitScmRuntime(() => operation.describePublishTargets({
            context,
            request: {
                cwd: '/workspace',
                providerId: 'scm.github.enterprise',
                providerKind: 'github',
            },
        }));

        expect(result).toMatchObject({
            success: true,
            auth: { profileKind: 'provider_cli' },
            defaultRepositoryName: 'workspace',
            targets: [expect.objectContaining({
                provider: expect.objectContaining({ id: 'scm.github.enterprise' }),
            })],
        });
        expect(githubDescribe).not.toHaveBeenCalled();
        expect(enterpriseDescribe).toHaveBeenCalledTimes(1);
    });

    it('fails existing remote conflicts by default after resolving the target repository', async () => {
        const createRepository = vi.fn(async () => repository);
        const remoteSetUrl = vi.fn();
        const remotePublish = vi.fn();
        const operation = createGitHostingRepositoryPublishOperation({
            registry: createRegistry({ createRepository }),
            readSnapshot: async () => snapshot({
                repo: {
                    ...snapshot().repo,
                    remotes: [{ name: 'origin', fetchUrl: 'https://example.com/old.git' }],
                },
            }),
            hasCurrentCommit: async () => true,
            remoteSetUrl,
            remotePublish,
        });

        const result = await publishWithRealGitRuntime(operation, {
            context,
            request: {
                cwd: '/workspace',
                providerKind: 'github',
                owner: 'happier-dev',
                repositoryName: 'project',
                visibility: 'private',
                remoteName: 'origin',
                pushCurrentBranch: true,
            },
        });

        expect(result).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_ALREADY_EXISTS,
            remediation: { kind: 'set_url_required' },
        });
        expect(createRepository).toHaveBeenCalledTimes(1);
        expect(remoteSetUrl).not.toHaveBeenCalled();
        expect(remotePublish).not.toHaveBeenCalled();
    });

    it('rejects invalid remote names before provider mutation', async () => {
        const createRepository = vi.fn(async () => repository);
        const remoteAdd = vi.fn();
        const operation = createGitHostingRepositoryPublishOperation({
            registry: createRegistry({ createRepository }),
            readSnapshot: async () => snapshot(),
            hasCurrentCommit: async () => true,
            remoteAdd,
        });

        const result = await publishWithRealGitRuntime(operation, {
            context,
            request: {
                cwd: '/workspace',
                providerKind: 'github',
                owner: 'happier-dev',
                repositoryName: 'project',
                visibility: 'private',
                remoteName: '--upload-pack=hack',
                pushCurrentBranch: false,
            },
        });

        expect(result).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
        });
        expect(createRepository).not.toHaveBeenCalled();
        expect(remoteAdd).not.toHaveBeenCalled();
    });

    it('sets an existing remote URL only when explicitly requested', async () => {
        const createRepository = vi.fn(async () => repository);
        const remoteSetUrl = vi.fn(async () => remoteSuccess(repository.cloneUrl!));
        const remoteAdd = vi.fn();
        const remotePublish = vi.fn();
        const operation = createGitHostingRepositoryPublishOperation({
            registry: createRegistry({ createRepository }),
            readSnapshot: async () => snapshot({
                repo: {
                    ...snapshot().repo,
                    remotes: [{ name: 'origin', fetchUrl: 'https://example.com/old.git' }],
                },
            }),
            hasCurrentCommit: async () => true,
            remoteAdd,
            remoteSetUrl,
            remotePublish,
        });

        const result = await publishWithRealGitRuntime(operation, {
            context,
            request: {
                cwd: '/workspace',
                providerKind: 'github',
                owner: 'happier-dev',
                repositoryName: 'project',
                visibility: 'private',
                remoteName: 'origin',
                remoteConflictStrategy: 'set-url',
                pushCurrentBranch: false,
            },
        });

        expect(result).toMatchObject({
            success: true,
            repository,
            remote: {
                name: 'origin',
                fetchUrl: repository.cloneUrl,
            },
            pushed: false,
        });
        expect(createRepository).toHaveBeenCalledTimes(1);
        expect(remoteSetUrl).toHaveBeenCalledWith({
            context,
            request: {
                cwd: '/workspace',
                name: 'origin',
                fetchUrl: repository.cloneUrl,
            },
        });
        expect(remoteAdd).not.toHaveBeenCalled();
        expect(remotePublish).not.toHaveBeenCalled();
    });

    it('sets an existing remote URL through real Git only when explicitly requested', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-hosting-publish-set-url-'));
        const oldRemote = mkdtempSync(join(tmpdir(), 'happier-git-hosting-publish-old-remote-'));
        const newRemote = mkdtempSync(join(tmpdir(), 'happier-git-hosting-publish-new-remote-'));
        git(oldRemote, ['init', '--bare']);
        git(newRemote, ['init', '--bare']);
        git(workspace, ['init', '-b', 'main']);
        git(workspace, ['remote', 'add', 'origin', oldRemote]);

        const repositoryWithLocalRemote: ScmHostingRepositorySummary = {
            ...repository,
            cloneUrl: newRemote,
        };
        const operation = createGitHostingRepositoryPublishOperation({
            registry: createRegistry({
                createRepository: vi.fn(async () => repositoryWithLocalRemote),
            }),
        });

        const result = await publishWithRealGitRuntime(operation, {
            context: {
                cwd: workspace,
                projectKey: `test:${workspace}`,
                detection: {
                    isRepo: true,
                    rootPath: workspace,
                    mode: '.git',
                },
            },
            request: publishRequest({
                cwd: '.',
                remoteConflictStrategy: 'set-url',
            }),
        });

        expect(result).toMatchObject({
            success: true,
            remote: {
                name: 'origin',
                fetchUrl: newRemote,
            },
            pushed: false,
        });
        expect(git(workspace, ['remote', 'get-url', 'origin'])).toBe(newRemote);
    });

    it('fails a real Git existing remote conflict by default without rewriting the remote', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-hosting-publish-conflict-'));
        const oldRemote = mkdtempSync(join(tmpdir(), 'happier-git-hosting-publish-conflict-old-'));
        const newRemote = mkdtempSync(join(tmpdir(), 'happier-git-hosting-publish-conflict-new-'));
        git(oldRemote, ['init', '--bare']);
        git(newRemote, ['init', '--bare']);
        git(workspace, ['init', '-b', 'main']);
        git(workspace, ['remote', 'add', 'origin', oldRemote]);

        const repositoryWithLocalRemote: ScmHostingRepositorySummary = {
            ...repository,
            cloneUrl: newRemote,
        };
        const operation = createGitHostingRepositoryPublishOperation({
            registry: createRegistry({
                createRepository: vi.fn(async () => repositoryWithLocalRemote),
            }),
        });

        const result = await publishWithRealGitRuntime(operation, {
            context: {
                cwd: workspace,
                projectKey: `test:${workspace}`,
                detection: {
                    isRepo: true,
                    rootPath: workspace,
                    mode: '.git',
                },
            },
            request: publishRequest({
                cwd: '.',
                pushCurrentBranch: false,
            }),
        });

        expect(result).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_ALREADY_EXISTS,
            remediation: { kind: 'set_url_required' },
        });
        expect(git(workspace, ['remote', 'get-url', 'origin'])).toBe(oldRemote);
    });

    it('returns commit-required before repository or remote mutation when push is requested without history', async () => {
        const createRepository = vi.fn(async () => repository);
        const remoteAdd = vi.fn();
        const operation = createGitHostingRepositoryPublishOperation({
            registry: createRegistry({ createRepository }),
            readSnapshot: async () => snapshot(),
            hasCurrentCommit: async () => false,
            remoteAdd,
        });

        const result = await publishWithRealGitRuntime(operation, {
            context,
            request: {
                cwd: '/workspace',
                providerKind: 'github',
                owner: 'happier-dev',
                repositoryName: 'project',
                visibility: 'private',
                remoteName: 'origin',
                pushCurrentBranch: true,
            },
        });

        expect(result).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.COMMIT_REQUIRED,
            remediation: { kind: 'commit_required' },
        });
        expect(createRepository).not.toHaveBeenCalled();
        expect(remoteAdd).not.toHaveBeenCalled();
    });

    it('rejects detached HEAD before repository or remote mutation when push is requested', async () => {
        const createRepository = vi.fn(async () => repository);
        const remoteAdd = vi.fn(async () => remoteSuccess(repository.cloneUrl!));
        const remotePublish = vi.fn(async (): Promise<ScmRemotePublishResponse> => ({ success: true }));
        const operation = createGitHostingRepositoryPublishOperation({
            registry: createRegistry({ createRepository }),
            readSnapshot: async () => snapshot({
                branch: {
                    head: null,
                    upstream: null,
                    ahead: 0,
                    behind: 0,
                    detached: true,
                },
            }),
            hasCurrentCommit: async () => true,
            remoteAdd,
            remotePublish,
        });

        const result = await publishWithRealGitRuntime(operation, {
            context,
            request: publishRequest({ pushCurrentBranch: true }),
        });

        expect(result).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
        });
        expect(createRepository).not.toHaveBeenCalled();
        expect(remoteAdd).not.toHaveBeenCalled();
        expect(remotePublish).not.toHaveBeenCalled();
    });

    it('rejects conflicted worktrees before repository or remote mutation when push is requested', async () => {
        const createRepository = vi.fn(async () => repository);
        const remoteAdd = vi.fn(async () => remoteSuccess(repository.cloneUrl!));
        const operation = createGitHostingRepositoryPublishOperation({
            registry: createRegistry({ createRepository }),
            readSnapshot: async () => snapshot({ hasConflicts: true }),
            hasCurrentCommit: async () => true,
            remoteAdd,
        });

        const result = await publishWithRealGitRuntime(operation, {
            context,
            request: publishRequest({ pushCurrentBranch: true }),
        });

        expect(result).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE,
        });
        expect(createRepository).not.toHaveBeenCalled();
        expect(remoteAdd).not.toHaveBeenCalled();
    });

    it('rejects branches behind upstream before repository or remote mutation when push is requested', async () => {
        const createRepository = vi.fn(async () => repository);
        const remoteAdd = vi.fn(async () => remoteSuccess(repository.cloneUrl!));
        const operation = createGitHostingRepositoryPublishOperation({
            registry: createRegistry({ createRepository }),
            readSnapshot: async () => snapshot({
                branch: {
                    head: 'feature/publish',
                    upstream: 'origin/feature/publish',
                    ahead: 0,
                    behind: 1,
                    detached: false,
                },
            }),
            hasCurrentCommit: async () => true,
            remoteAdd,
        });

        const result = await publishWithRealGitRuntime(operation, {
            context,
            request: publishRequest({ pushCurrentBranch: true }),
        });

        expect(result).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD,
        });
        expect(createRepository).not.toHaveBeenCalled();
        expect(remoteAdd).not.toHaveBeenCalled();
    });

    it('attaches the remote without pushing when publish is requested without history', async () => {
        const createRepository = vi.fn(async () => repository);
        const remoteAdd = vi.fn(async () => remoteSuccess(repository.cloneUrl!));
        const remotePublish = vi.fn();
        const operation = createGitHostingRepositoryPublishOperation({
            registry: createRegistry({ createRepository }),
            readSnapshot: async () => snapshot(),
            hasCurrentCommit: async () => false,
            remoteAdd,
            remotePublish,
        });

        const result = await publishWithRealGitRuntime(operation, {
            context,
            request: {
                cwd: '/workspace',
                providerKind: 'github',
                owner: 'happier-dev',
                repositoryName: 'project',
                visibility: 'private',
                remoteName: 'origin',
                pushCurrentBranch: false,
            },
        });

        expect(result).toMatchObject({
            success: true,
            repository,
            remote: {
                name: 'origin',
                fetchUrl: repository.cloneUrl,
            },
            pushed: false,
        });
        expect(createRepository).toHaveBeenCalledTimes(1);
        expect(remoteAdd).toHaveBeenCalledWith({
            context,
            request: {
                cwd: '/workspace',
                name: 'origin',
                fetchUrl: repository.cloneUrl,
            },
        });
        expect(remotePublish).not.toHaveBeenCalled();
    });

    it('attaches a remote through real Git without pushing when the repository has no history', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-hosting-publish-empty-no-push-'));
        const bareRemote = mkdtempSync(join(tmpdir(), 'happier-git-hosting-publish-empty-remote-'));
        git(bareRemote, ['init', '--bare']);
        git(workspace, ['init', '-b', 'main']);

        const repositoryWithLocalRemote: ScmHostingRepositorySummary = {
            ...repository,
            cloneUrl: bareRemote,
        };
        const operation = createGitHostingRepositoryPublishOperation({
            registry: createRegistry({
                createRepository: vi.fn(async () => repositoryWithLocalRemote),
            }),
        });

        const result = await publishWithRealGitRuntime(operation, {
            context: {
                cwd: workspace,
                projectKey: `test:${workspace}`,
                detection: {
                    isRepo: true,
                    rootPath: workspace,
                    mode: '.git',
                },
            },
            request: publishRequest({
                cwd: '.',
                pushCurrentBranch: false,
            }),
        });

        expect(result).toMatchObject({
            success: true,
            pushed: false,
            remote: {
                name: 'origin',
                fetchUrl: bareRemote,
            },
        });
        expect(git(workspace, ['remote', 'get-url', 'origin'])).toBe(bareRemote);
        expect(gitExitStatus(bareRemote, ['show-ref'])).toBe(1);
    });

    it('rejects invalid remote names against a real Git repository before provider mutation', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-hosting-publish-invalid-remote-'));
        git(workspace, ['init', '-b', 'main']);
        const createRepository = vi.fn(async () => repository);
        const operation = createGitHostingRepositoryPublishOperation({
            registry: createRegistry({ createRepository }),
        });

        const result = await publishWithRealGitRuntime(operation, {
            context: {
                cwd: workspace,
                projectKey: `test:${workspace}`,
                detection: {
                    isRepo: true,
                    rootPath: workspace,
                    mode: '.git',
                },
            },
            request: publishRequest({
                cwd: '.',
                remoteName: '--upload-pack=hack',
            }),
        });

        expect(result).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
        });
        expect(createRepository).not.toHaveBeenCalled();
        expect(git(workspace, ['remote'])).toBe('');
    });

    it('reuses a matching existing remote through real Git without rewriting it', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-hosting-publish-matching-remote-'));
        const bareRemote = mkdtempSync(join(tmpdir(), 'happier-git-hosting-publish-matching-bare-'));
        git(bareRemote, ['init', '--bare']);
        git(workspace, ['init', '-b', 'main']);
        git(workspace, ['remote', 'add', 'origin', bareRemote]);

        const repositoryWithLocalRemote: ScmHostingRepositorySummary = {
            ...repository,
            cloneUrl: bareRemote,
        };
        const operation = createGitHostingRepositoryPublishOperation({
            registry: createRegistry({
                createRepository: vi.fn(async () => repositoryWithLocalRemote),
            }),
        });

        const result = await publishWithRealGitRuntime(operation, {
            context: {
                cwd: workspace,
                projectKey: `test:${workspace}`,
                detection: {
                    isRepo: true,
                    rootPath: workspace,
                    mode: '.git',
                },
            },
            request: publishRequest({
                cwd: '.',
                pushCurrentBranch: false,
            }),
        });

        expect(result).toMatchObject({
            success: true,
            pushed: false,
            remote: {
                name: 'origin',
                fetchUrl: bareRemote,
            },
        });
        expect(git(workspace, ['remote', 'get-url', 'origin'])).toBe(bareRemote);
    });

    it('invalidates PR status cache when remote mutation succeeds before a failed push returns', async () => {
        defaultPrStatusCache.clear();
        const cacheKey = {
            workspaceKey: context.projectKey,
            repoRootPath: context.detection.rootPath!,
            provider,
            headBranch: 'feature/publish',
            state: 'open' as const,
        };
        defaultPrStatusCache.setSuccess({
            key: cacheKey,
            pullRequests: [],
        });

        const createRepository = vi.fn(async () => repository);
        const remoteAdd = vi.fn(async () => remoteSuccess(repository.cloneUrl!));
        const remotePublish = vi.fn(async (): Promise<ScmRemotePublishResponse> => ({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD,
            error: 'push rejected',
        }));
        const operation = createGitHostingRepositoryPublishOperation({
            registry: createRegistry({ createRepository }),
            readSnapshot: async () => snapshot(),
            hasCurrentCommit: async () => true,
            remoteAdd,
            remotePublish,
        });

        const result = await publishWithRealGitRuntime(operation, {
            context,
            request: publishRequest({ pushCurrentBranch: true }),
        });

        expect(result).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD,
        });
        expect(defaultPrStatusCache.getFresh(cacheKey)).toBeNull();
    });

    it('publishes the current branch through the existing publish primitive without force options', async () => {
        const createRepository = vi.fn(async () => repository);
        const remoteAdd = vi.fn(async () => remoteSuccess(repository.cloneUrl!));
        const remotePublish = vi.fn(async (): Promise<ScmRemotePublishResponse> => ({ success: true }));
        const operation = createGitHostingRepositoryPublishOperation({
            registry: createRegistry({ createRepository }),
            readSnapshot: async () => snapshot(),
            hasCurrentCommit: async () => true,
            remoteAdd,
            remotePublish,
        });

        const result = await publishWithRealGitRuntime(operation, {
            context,
            request: {
                cwd: '/workspace',
                providerKind: 'github',
                owner: 'happier-dev',
                repositoryName: 'project',
                visibility: 'private',
                remoteName: 'origin',
                pushCurrentBranch: true,
            },
        });

        expect(result).toMatchObject({
            success: true,
            pushed: true,
        });
        expect(remotePublish).toHaveBeenCalledWith({
            context,
            request: {
                cwd: '/workspace',
                remote: 'origin',
            },
        });
        const source = readFileSync(new URL('./hostingRepositoryPublishOperations.ts', import.meta.url), 'utf8');
        expect(source).not.toMatch(/--force|push --force|push -f|force-push/i);
    });
});
