import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
    SCM_OPERATION_ERROR_CODES,
    createScmCapabilities,
    type ScmRepositoryCloneInput,
    type ScmRepositoryCloneOutput,
    type ScmWorkingSnapshot,
    type ScmRepositoryCloneTargetDescription,
} from '@happier-dev/protocol';
import { runWithScmBackendRuntimeServices } from '@happier-dev/plugin-sdk/scm/backend';
import { describe, expect, it } from 'vitest';

import type { ScmBackendContext } from '../types.js';
import { createGitRepositoryCloneOperation } from './repositoryCloneOperations.js';

type RepositoryCloneOperation = (input: {
    context: ScmBackendContext;
    request: ScmRepositoryCloneInput;
}) => Promise<ScmRepositoryCloneOutput>;

function runGit(cwd: string, args: string[]): string {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

function runWithRealGitRuntime<T>(callback: () => T): T {
    return runWithScmBackendRuntimeServices({
        async runCommand(input) {
            if (input.command !== 'git') {
                return {
                    success: false,
                    stdout: '',
                    stderr: `Unsupported command: ${input.command}`,
                    exitCode: -1,
                };
            }
            const result = spawnSync('git', [...input.args], {
                cwd: input.cwd,
                input: input.stdin,
                encoding: 'utf8',
                env: input.env ? { ...process.env, ...input.env } : process.env,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            return {
                success: result.status === 0,
                stdout: result.stdout ?? '',
                stderr: result.stderr ?? '',
                exitCode: result.status ?? -1,
            };
        },
    }, callback);
}

function cloneWithRealGitRuntime(
    repositoryClone: RepositoryCloneOperation,
    input: Parameters<RepositoryCloneOperation>[0],
) {
    return runWithRealGitRuntime(() => repositoryClone(input));
}

function createWorkspace(): string {
    return mkdtempSync(join(tmpdir(), 'happier-git-clone-operation-'));
}

function readSnapshotFromGit(context: ScmBackendContext): ScmWorkingSnapshot {
    return {
        projectKey: context.projectKey,
        fetchedAt: Date.now(),
        repo: {
            isRepo: true,
            backendId: 'git',
            mode: '.git',
            rootPath: runGit(context.cwd, ['rev-parse', '--show-toplevel']),
            remotes: [],
            worktrees: [],
        },
        capabilities: createScmCapabilities(),
        branch: {
            head: runGit(context.cwd, ['branch', '--show-current']) || null,
            upstream: null,
            ahead: 0,
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

function getRepositoryCloneOperation(
    deps?: Parameters<typeof createGitRepositoryCloneOperation>[0],
): RepositoryCloneOperation {
    const operation = createGitRepositoryCloneOperation({
        ...deps,
        readSnapshot: deps?.readSnapshot ?? (async ({ context }) => readSnapshotFromGit(context)),
    });
    expect(operation.clone).toBeTypeOf('function');
    return operation.clone;
}

function makeContext(cwd: string): ScmBackendContext {
    return {
        cwd,
        projectKey: `test:${cwd}`,
        detection: { isRepo: false, rootPath: null, mode: null },
    };
}

function createBareRemoteRepository(): string {
    const root = createWorkspace();
    const source = join(root, 'source');
    const bare = join(root, 'remote.git');
    mkdirSync(source, { recursive: true });
    runGit(source, ['init', '-b', 'main']);
    runGit(source, ['config', 'user.email', 'test@example.com']);
    runGit(source, ['config', 'user.name', 'Test User']);
    writeFileSync(join(source, 'README.md'), 'hello\n');
    runGit(source, ['add', 'README.md']);
    runGit(source, ['commit', '-m', 'initial']);
    runGit(root, ['clone', '--bare', source, bare]);
    return bare;
}

function makeRequest(parent: string, remotePath: string, destinationDirectoryName = 'happier'): ScmRepositoryCloneInput {
    return {
        provider: {
            id: 'github:github.com',
            kind: 'github',
            displayName: 'GitHub',
            baseUrl: 'https://github.com',
            urlSafety: { allowedSchemes: ['https:'] },
        },
        repository: {
            nameWithOwner: 'happier-dev/happier',
            webUrl: 'https://github.com/happier-dev/happier',
            cloneUrl: `file://${remotePath}`,
            visibility: 'public',
            defaultBranch: 'main',
        },
        destinationParentPath: parent,
        destinationDirectoryName,
        protocol: 'https',
        confirmed: true,
        authorizationToken: 'clone-repository',
    };
}

function makeProviderRegistry(description: ScmRepositoryCloneTargetDescription) {
    return {
        getProvider: () => description.repository.provider,
        getAdapter: () => ({
            describeCloneTargets: async () => description,
        }),
    };
}

function makeCloneTargetDescription(remotePath: string): ScmRepositoryCloneTargetDescription {
    return {
        auth: { state: 'authenticated', profileKind: 'provider_cli' },
        repository: {
            provider: {
                id: 'github:github.com',
                kind: 'github',
                displayName: 'GitHub',
                baseUrl: 'https://github.com',
                urlSafety: { allowedSchemes: ['https:'] },
            },
            nameWithOwner: 'happier-dev/happier',
            webUrl: 'https://github.com/happier-dev/happier',
            cloneUrl: `file://${remotePath}`,
            visibility: 'public',
            defaultBranch: 'main',
        },
        targets: [
            {
                protocol: 'https',
                url: `file://${remotePath}`,
                isDefault: true,
            },
        ],
    };
}

describe('git repository clone operation', () => {
    it('requires provider-owned clone target discovery instead of trusting request clone URLs', async () => {
        const parent = createWorkspace();
        const remotePath = createBareRemoteRepository();
        const repositoryClone = getRepositoryCloneOperation({
            registry: {
                getAdapter: () => undefined,
            },
        });

        const response = await cloneWithRealGitRuntime(repositoryClone, {
            context: makeContext(parent),
            request: makeRequest(parent, remotePath),
        });

        expect(response).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
        });
        expect(existsSync(join(parent, 'happier'))).toBe(false);
    });

    it('uses the registered provider descriptor and sanitized repository selector for clone target discovery', async () => {
        const parent = createWorkspace();
        const remotePath = createBareRemoteRepository();
        const canonicalProvider = {
            id: 'scm.github',
            kind: 'github',
            displayName: 'GitHub',
            baseUrl: 'https://github.com',
            urlSafety: { allowedSchemes: ['https:'] },
        } satisfies ScmRepositoryCloneInput['provider'];
        const observed: Array<Readonly<{
            providerBaseUrl: string;
            hasCloneUrl: boolean;
            hasSshUrl: boolean;
        }>> = [];
        const clonedUrls: string[] = [];
        const repositoryClone = getRepositoryCloneOperation({
            registry: {
                getProvider: () => canonicalProvider,
                getAdapter: () => ({
                    describeCloneTargets: async ({ provider, repository }) => {
                        observed.push({
                            providerBaseUrl: provider.baseUrl,
                            hasCloneUrl: 'cloneUrl' in repository,
                            hasSshUrl: 'sshUrl' in repository,
                        });
                        return {
                            auth: { state: 'authenticated', profileKind: 'provider_cli' },
                            repository: {
                                provider,
                                nameWithOwner: repository.nameWithOwner,
                                webUrl: `${provider.baseUrl}/${repository.nameWithOwner}`,
                                cloneUrl: `${provider.baseUrl}/${repository.nameWithOwner}.git`,
                                visibility: repository.visibility,
                                defaultBranch: repository.defaultBranch,
                            },
                            targets: [
                                {
                                    protocol: 'https',
                                    url: `${provider.baseUrl}/${repository.nameWithOwner}.git`,
                                    isDefault: true,
                                },
                            ],
                        };
                    },
                }),
            },
            runCommand: async (request) => {
                clonedUrls.push(request.args[1] ?? '');
                mkdirSync(resolve(parent, 'happier', '.git'), { recursive: true });
                return { success: true, stdout: '', stderr: '', exitCode: 0 };
            },
            detectRepo: async () => ({ isRepo: true, rootPath: resolve(parent, 'happier'), mode: '.git' }),
            readSnapshot: async ({ context }) => ({
                projectKey: context.projectKey,
                fetchedAt: Date.now(),
                repo: {
                    isRepo: true,
                    backendId: 'git',
                    mode: '.git',
                    rootPath: context.cwd,
                    remotes: [],
                    worktrees: [],
                },
                capabilities: createScmCapabilities(),
                branch: {
                    head: 'main',
                    upstream: null,
                    ahead: 0,
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
            }),
        });

        const response = await cloneWithRealGitRuntime(repositoryClone, {
            context: makeContext(parent),
            request: {
                ...makeRequest(parent, remotePath),
                provider: {
                    ...canonicalProvider,
                    baseUrl: 'https://attacker.example',
                },
                repository: {
                    nameWithOwner: 'happier-dev/happier',
                    webUrl: 'https://attacker.example/happier-dev/happier',
                    cloneUrl: 'https://attacker.example/happier-dev/happier.git',
                    sshUrl: 'git@attacker.example:happier-dev/happier.git',
                    visibility: 'public',
                    defaultBranch: 'main',
                },
            },
        });

        expect(response.success).toBe(true);
        expect(observed).toEqual([
            {
                providerBaseUrl: 'https://github.com',
                hasCloneUrl: false,
                hasSshUrl: false,
            },
        ]);
        expect(clonedUrls).toEqual(['https://github.com/happier-dev/happier.git']);
        expect(clonedUrls).not.toContain('https://attacker.example/happier-dev/happier.git');
    });

    it('clones into a conflict-free destination and returns a rediscovered repository snapshot', async () => {
        const parent = createWorkspace();
        const remotePath = createBareRemoteRepository();
        const repositoryClone = getRepositoryCloneOperation({
            registry: makeProviderRegistry(makeCloneTargetDescription(remotePath)),
        });

        const response = await cloneWithRealGitRuntime(repositoryClone, {
            context: makeContext(parent),
            request: makeRequest(parent, remotePath),
        });

        expect(response.success).toBe(true);
        if (!response.success) {
            throw new Error(response.error);
        }
        const destination = resolve(parent, 'happier');
        expect(response.destinationPath).toBe(destination);
        expect(response.cloneProtocol).toBe('https');
        expect(existsSync(join(destination, 'README.md'))).toBe(true);
        expect(response.snapshot?.repo).toMatchObject({
            isRepo: true,
            backendId: 'git',
            mode: '.git',
            rootPath: runGit(destination, ['rev-parse', '--show-toplevel']),
        });
        expect(response.snapshot?.branch.head).toBe('main');
    });

    it('rejects non-empty destination directories before running clone', async () => {
        const parent = createWorkspace();
        const remotePath = createBareRemoteRepository();
        const destination = join(parent, 'happier');
        mkdirSync(destination);
        writeFileSync(join(destination, 'existing.txt'), 'keep\n');
        const repositoryClone = getRepositoryCloneOperation({
            registry: makeProviderRegistry(makeCloneTargetDescription(remotePath)),
        });

        const response = await cloneWithRealGitRuntime(repositoryClone, {
            context: makeContext(parent),
            request: makeRequest(parent, remotePath),
        });

        expect(response).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH,
        });
        expect(existsSync(join(destination, 'existing.txt'))).toBe(true);
        expect(existsSync(join(destination, '.git'))).toBe(false);
    });
});
