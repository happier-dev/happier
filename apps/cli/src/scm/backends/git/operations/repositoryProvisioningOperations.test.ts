import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { describe, expect, it } from 'vitest';

import type {
    ConnectedServiceCredentialRecordV1,
    ScmHostingRepositoryPublishResponse,
    ScmHostingRepositoryPublishTarget,
    ScmHostingRepositorySummary,
} from '@happier-dev/protocol';
import {
    buildConnectedServiceCredentialRecord,
} from '@happier-dev/protocol';

import type { ScmBackendContext } from '../../../types';
import type {
    ScmHostingProviderCreateRepositoryInput,
    ScmHostingProviderListRepositoryPublishTargetsInput,
} from '../../../hostingProviders/types';

function createCommittedGitRepository(): string {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-git-provisioning-'));
    runGit(workspace, ['init']);
    runGit(workspace, ['config', 'user.email', 'test@example.com']);
    runGit(workspace, ['config', 'user.name', 'Test User']);
    runGit(workspace, ['branch', '-M', 'main']);
    writeFileSync(join(workspace, 'README.md'), '# Project\n');
    runGit(workspace, ['add', 'README.md']);
    runGit(workspace, ['commit', '-m', 'initial commit']);
    return workspace;
}

function runGit(cwd: string, args: string[]): string {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

describe('git repository provisioning operations', () => {
    it('uses the detected GitHub Enterprise host when describing publish targets', async () => {
        const mod = await import('./repositoryProvisioningOperations') as Record<string, unknown>;
        const createBackend = mod.createGitRepositoryProvisioningBackend;
        expect(createBackend).toBeTypeOf('function');
        if (typeof createBackend !== 'function') {
            throw new Error('expected repository provisioning backend factory');
        }

        const workspace = createCommittedGitRepository();
        runGit(workspace, ['remote', 'add', 'origin', 'https://github.company.com/happier-dev/happier.git']);
        let restCalls = 0;
        let cliAuthCalls = 0;
        const backend = createBackend({
            githubRestAdapter: {
                kind: 'github',
                name: 'GitHub REST',
                detectRemote: () => null,
                buildCompareUrl: () => null,
                listRepositoryPublishTargets: async (
                    input: ScmHostingProviderListRepositoryPublishTargetsInput,
                ): Promise<readonly ScmHostingRepositoryPublishTarget[]> => {
                    restCalls += 1;
                    expect(input.providerBaseUrl).toBe('https://github.company.com');
                    return [{
                        providerKind: 'github',
                        owner: 'happier-dev',
                        ownerKind: 'user',
                        label: 'happier-dev',
                        default: true,
                        supportedVisibilities: ['private', 'public'],
                    }];
                },
            },
            detectGithubCliAuth: async ({ providerBaseUrl }: { providerBaseUrl: string }) => {
                cliAuthCalls += 1;
                expect(providerBaseUrl).toBe('https://github.company.com');
                return { kind: 'missing-auth' };
            },
        });
        const githubCredential: ConnectedServiceCredentialRecordV1 = buildConnectedServiceCredentialRecord({
            now: 1_000,
            serviceId: 'github',
            profileId: 'primary',
            kind: 'token',
            token: {
                token: 'ghp_enterprise',
                providerAccountId: '42',
                providerEmail: 'octo@example.com',
            },
        });
        const context: ScmBackendContext = {
            cwd: workspace,
            projectKey: `test:${workspace}`,
            detection: {
                isRepo: true,
                rootPath: workspace,
                mode: '.git',
            },
            connectedAccounts: {
                resolveCredential: async (serviceId) => serviceId === 'github' ? githubCredential : null,
            },
        };

        const response = await backend.describePublishTargets({
            context,
            request: {
                cwd: '.',
                providerKind: 'github',
            },
        });

        expect(response).toMatchObject({
            success: true,
            auth: {
                kind: 'connected-account',
            },
            targets: [{
                owner: 'happier-dev',
            }],
        });
        expect(restCalls).toBe(1);
        expect(cliAuthCalls).toBe(0);
    });

    it('includes the gh installable key when GitHub publish target discovery falls back to unauthenticated auth', async () => {
        const mod = await import('./repositoryProvisioningOperations') as Record<string, unknown>;
        const createBackend = mod.createGitRepositoryProvisioningBackend;
        expect(createBackend).toBeTypeOf('function');
        if (typeof createBackend !== 'function') {
            throw new Error('expected repository provisioning backend factory');
        }

        const workspace = createCommittedGitRepository();
        const backend = createBackend({
            detectGithubCliAuth: async () => ({ kind: 'missing-auth' }),
        });
        const context: ScmBackendContext = {
            cwd: workspace,
            projectKey: `test:${workspace}`,
            detection: {
                isRepo: true,
                rootPath: workspace,
                mode: '.git',
            },
        };

        const response = await backend.describePublishTargets({
            context,
            request: {
                cwd: '.',
                providerKind: 'github',
            },
        });

        expect(response).toMatchObject({
            success: true,
            auth: {
                kind: 'none',
                authenticated: false,
                installableKey: 'gh',
            },
            targets: [],
        });
    });

    it('rejects invalid remote names before attempting external repository creation', async () => {
        const mod = await import('./repositoryProvisioningOperations') as Record<string, unknown>;
        const createBackend = mod.createGitRepositoryProvisioningBackend;
        expect(createBackend).toBeTypeOf('function');
        if (typeof createBackend !== 'function') {
            throw new Error('expected repository provisioning backend factory');
        }

        const workspace = createCommittedGitRepository();
        let createRepositoryCalls = 0;
        const backend = createBackend({
            githubCliAdapter: {
                kind: 'github',
                name: 'GitHub CLI',
                detectRemote: () => null,
                buildCompareUrl: () => null,
                createRepository: async (): Promise<ScmHostingRepositorySummary> => {
                    createRepositoryCalls += 1;
                    return {
                        provider: {
                            kind: 'github',
                            name: 'GitHub',
                            baseUrl: 'https://github.com',
                            nameWithOwner: 'happier-dev/published-repo',
                        },
                        nameWithOwner: 'happier-dev/published-repo',
                        url: 'https://github.com/happier-dev/published-repo',
                        cloneUrl: 'https://github.com/happier-dev/published-repo.git',
                        sshUrl: 'git@github.com:happier-dev/published-repo.git',
                        visibility: 'private',
                        defaultBranch: 'main',
                    };
                },
            },
            detectGithubCliAuth: async () => ({ kind: 'authenticated' }),
        });
        const context: ScmBackendContext = {
            cwd: workspace,
            projectKey: `test:${workspace}`,
            detection: {
                isRepo: true,
                rootPath: workspace,
                mode: '.git',
            },
        };

        const response = await backend.publishToHostingProvider({
            context,
            request: {
                cwd: '.',
                providerKind: 'github',
                owner: 'happier-dev',
                ownerKind: 'user',
                repositoryName: 'published-repo',
                visibility: 'private',
                remoteName: 'bad name with spaces',
            },
        }) as ScmHostingRepositoryPublishResponse;

        expect(response).toMatchObject({
            success: false,
            errorCode: 'INVALID_REQUEST',
        });
        expect(createRepositoryCalls).toBe(0);
    });

    it('falls back to authenticated gh when connected-account repository creation fails', async () => {
        const mod = await import('./repositoryProvisioningOperations') as Record<string, unknown>;
        const createBackend = mod.createGitRepositoryProvisioningBackend;
        expect(createBackend).toBeTypeOf('function');
        if (typeof createBackend !== 'function') {
            throw new Error('expected repository provisioning backend factory');
        }

        const workspace = createCommittedGitRepository();
        let restCreateRepositoryCalls = 0;
        let cliCreateRepositoryCalls = 0;
        const backend = createBackend({
            githubRestAdapter: {
                kind: 'github',
                name: 'GitHub REST',
                detectRemote: () => null,
                buildCompareUrl: () => null,
                createRepository: async () => {
                    restCreateRepositoryCalls += 1;
                    throw new Error('expired token');
                },
            },
            githubCliAdapter: {
                kind: 'github',
                name: 'GitHub CLI',
                detectRemote: () => null,
                buildCompareUrl: () => null,
                createRepository: async (): Promise<ScmHostingRepositorySummary> => {
                    cliCreateRepositoryCalls += 1;
                    return {
                        provider: {
                            kind: 'github',
                            name: 'GitHub',
                            baseUrl: 'https://github.com',
                            nameWithOwner: 'happier-dev/published-repo',
                        },
                        nameWithOwner: 'happier-dev/published-repo',
                        url: 'https://github.com/happier-dev/published-repo',
                        cloneUrl: 'https://github.com/happier-dev/published-repo.git',
                        sshUrl: 'git@github.com:happier-dev/published-repo.git',
                        visibility: 'private',
                        defaultBranch: 'main',
                    };
                },
            },
            detectGithubCliAuth: async () => ({ kind: 'authenticated' }),
        });
        const githubCredential: ConnectedServiceCredentialRecordV1 = buildConnectedServiceCredentialRecord({
            now: 1_000,
            serviceId: 'github',
            profileId: 'primary',
            kind: 'token',
            token: {
                token: 'ghp_expired',
                providerAccountId: '42',
                providerEmail: 'octo@example.com',
            },
        });
        const context: ScmBackendContext = {
            cwd: workspace,
            projectKey: `test:${workspace}`,
            detection: {
                isRepo: true,
                rootPath: workspace,
                mode: '.git',
            },
            connectedAccounts: {
                resolveCredential: async (serviceId) => serviceId === 'github' ? githubCredential : null,
            },
        };

        const response = await backend.publishToHostingProvider({
            context,
            request: {
                cwd: '.',
                providerKind: 'github',
                owner: 'happier-dev',
                ownerKind: 'user',
                repositoryName: 'published-repo',
                visibility: 'private',
                remoteName: 'origin',
                remoteUrlKind: 'https',
                remoteConflictStrategy: 'fail',
                pushCurrentBranch: false,
            },
        }) as ScmHostingRepositoryPublishResponse;

        expect(response).toMatchObject({
            success: true,
            repository: {
                nameWithOwner: 'happier-dev/published-repo',
            },
            remote: {
                name: 'origin',
                fetchUrl: 'https://github.com/happier-dev/published-repo.git',
            },
        });
        expect(restCreateRepositoryCalls).toBe(1);
        expect(cliCreateRepositoryCalls).toBe(1);
        expect(runGit(workspace, ['remote', 'get-url', 'origin'])).toBe('https://github.com/happier-dev/published-repo.git');
    });

    it('uses the detected GitHub Enterprise host when creating repositories', async () => {
        const mod = await import('./repositoryProvisioningOperations') as Record<string, unknown>;
        const createBackend = mod.createGitRepositoryProvisioningBackend;
        expect(createBackend).toBeTypeOf('function');
        if (typeof createBackend !== 'function') {
            throw new Error('expected repository provisioning backend factory');
        }

        const workspace = createCommittedGitRepository();
        runGit(workspace, ['remote', 'add', 'origin', 'https://github.company.com/happier-dev/happier.git']);
        let restCreateRepositoryCalls = 0;
        const backend = createBackend({
            githubRestAdapter: {
                kind: 'github',
                name: 'GitHub REST',
                detectRemote: () => null,
                buildCompareUrl: () => null,
                createRepository: async (
                    input: ScmHostingProviderCreateRepositoryInput,
                ): Promise<ScmHostingRepositorySummary> => {
                    restCreateRepositoryCalls += 1;
                    expect(input.providerBaseUrl).toBe('https://github.company.com');
                    return {
                        provider: {
                            kind: 'github',
                            name: 'GitHub',
                            baseUrl: 'https://github.company.com',
                            nameWithOwner: 'happier-dev/published-repo',
                        },
                        nameWithOwner: 'happier-dev/published-repo',
                        url: 'https://github.company.com/happier-dev/published-repo',
                        cloneUrl: 'https://github.company.com/happier-dev/published-repo.git',
                        sshUrl: 'git@github.company.com:happier-dev/published-repo.git',
                        visibility: 'private',
                        defaultBranch: 'main',
                    };
                },
            },
            detectGithubCliAuth: async ({ providerBaseUrl }: { providerBaseUrl: string }) => {
                expect(providerBaseUrl).toBe('https://github.company.com');
                return { kind: 'missing-auth' };
            },
        });
        const githubCredential: ConnectedServiceCredentialRecordV1 = buildConnectedServiceCredentialRecord({
            now: 1_000,
            serviceId: 'github',
            profileId: 'primary',
            kind: 'token',
            token: {
                token: 'ghp_enterprise',
                providerAccountId: '42',
                providerEmail: 'octo@example.com',
            },
        });
        const context: ScmBackendContext = {
            cwd: workspace,
            projectKey: `test:${workspace}`,
            detection: {
                isRepo: true,
                rootPath: workspace,
                mode: '.git',
            },
            connectedAccounts: {
                resolveCredential: async (serviceId) => serviceId === 'github' ? githubCredential : null,
            },
        };

        const response = await backend.publishToHostingProvider({
            context,
            request: {
                cwd: '.',
                providerKind: 'github',
                owner: 'happier-dev',
                ownerKind: 'user',
                repositoryName: 'published-repo',
                visibility: 'private',
                remoteName: 'origin',
                remoteUrlKind: 'https',
                remoteConflictStrategy: 'set-url',
                pushCurrentBranch: false,
            },
        }) as ScmHostingRepositoryPublishResponse;

        expect(response).toMatchObject({
            success: true,
            repository: {
                provider: {
                    baseUrl: 'https://github.company.com',
                },
            },
            remote: {
                name: 'origin',
                fetchUrl: 'https://github.company.com/happier-dev/published-repo.git',
            },
        });
        expect(restCreateRepositoryCalls).toBe(1);
        expect(runGit(workspace, ['remote', 'get-url', 'origin'])).toBe('https://github.company.com/happier-dev/published-repo.git');
    });

    it('rejects repository publish requests without an owner kind before provider creation', async () => {
        const mod = await import('./repositoryProvisioningOperations') as Record<string, unknown>;
        const createBackend = mod.createGitRepositoryProvisioningBackend;
        expect(createBackend).toBeTypeOf('function');
        if (typeof createBackend !== 'function') {
            throw new Error('expected repository provisioning backend factory');
        }

        const workspace = createCommittedGitRepository();
        let createRepositoryCalls = 0;
        const backend = createBackend({
            githubCliAdapter: {
                kind: 'github',
                name: 'GitHub CLI',
                detectRemote: () => null,
                buildCompareUrl: () => null,
                createRepository: async (): Promise<ScmHostingRepositorySummary> => {
                    createRepositoryCalls += 1;
                    throw new Error('repository creation must not run without an owner kind');
                },
            },
            detectGithubCliAuth: async () => ({ kind: 'authenticated' }),
        });

        const response = await backend.publishToHostingProvider({
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
                repositoryName: 'published-repo',
                visibility: 'private',
            } as never,
        }) as ScmHostingRepositoryPublishResponse;

        expect(response).toMatchObject({
            success: false,
            errorCode: 'INVALID_REQUEST',
        });
        expect(createRepositoryCalls).toBe(0);
    });

    it('removes only the Git index lock file reported by Git', async () => {
        const mod = await import('./repositoryProvisioningOperations') as Record<string, unknown>;
        const createBackend = mod.createGitRepositoryProvisioningBackend;
        expect(createBackend).toBeTypeOf('function');
        if (typeof createBackend !== 'function') {
            throw new Error('expected repository provisioning backend factory');
        }

        const workspace = createCommittedGitRepository();
        const lockPath = join(workspace, '.git', 'index.lock');
        mkdirSync(join(workspace, '.git'), { recursive: true });
        writeFileSync(lockPath, 'stale lock');

        const backend = createBackend({}) as Record<string, unknown>;
        expect(backend.removeIndexLock).toBeTypeOf('function');
        const removeIndexLock = backend.removeIndexLock;
        if (typeof removeIndexLock !== 'function') throw new Error('expected removeIndexLock operation');

        const response = await removeIndexLock({
            context: {
                cwd: workspace,
                projectKey: `test:${workspace}`,
                detection: {
                    isRepo: true,
                    rootPath: workspace,
                    mode: '.git',
                },
            },
            request: { cwd: '.' },
        });

        expect(response).toMatchObject({
            success: true,
            removed: true,
            lockPath,
        });
        expect(existsSync(lockPath)).toBe(false);
    });

    it('removes linked-worktree index locks that Git resolves outside the worktree root', async () => {
        const mod = await import('./repositoryProvisioningOperations') as Record<string, unknown>;
        const createBackend = mod.createGitRepositoryProvisioningBackend;
        expect(createBackend).toBeTypeOf('function');
        if (typeof createBackend !== 'function') {
            throw new Error('expected repository provisioning backend factory');
        }

        const workspace = createCommittedGitRepository();
        const linkedWorktree = join(mkdtempSync(join(tmpdir(), 'happier-linked-worktree-')), 'feature-worktree');
        runGit(workspace, ['worktree', 'add', '-b', 'feature/index-lock', linkedWorktree, 'HEAD']);

        const lockPathOutput = runGit(linkedWorktree, ['rev-parse', '--git-path', 'index.lock']);
        const lockPath = lockPathOutput.startsWith('/')
            ? lockPathOutput
            : join(linkedWorktree, lockPathOutput);
        mkdirSync(dirname(lockPath), { recursive: true });
        writeFileSync(lockPath, 'linked worktree lock');

        const backend = createBackend({}) as Record<string, unknown>;
        expect(backend.removeIndexLock).toBeTypeOf('function');
        const removeIndexLock = backend.removeIndexLock;
        if (typeof removeIndexLock !== 'function') throw new Error('expected removeIndexLock operation');

        const response = await removeIndexLock({
            context: {
                cwd: linkedWorktree,
                projectKey: `test:${linkedWorktree}`,
                detection: {
                    isRepo: true,
                    rootPath: linkedWorktree,
                    mode: '.git',
                },
            },
            request: { cwd: '.' },
        });

        expect(response).toMatchObject({
            success: true,
            removed: true,
            lockPath,
        });
        expect(existsSync(lockPath)).toBe(false);
    });
});
