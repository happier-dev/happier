import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/experimental/scm';
import { describe, expect, it } from 'vitest';

import {
    cloneWithRealGitRuntime,
    createBareRemoteRepository,
    createInMemorySnapshot,
    createWorkspace,
    getRepositoryCloneOperation,
    makeCloneTargetDescription,
    makeContext,
    makeProviderRegistry,
    makeRequest,
    runGit,
} from './repositoryCloneOperations.test-support.js';

describe('git repository clone snapshot readback', () => {
    it('returns a typed failure when the published destination is removed during repository detection', async () => {
        const parent = createWorkspace();
        const remotePath = createBareRemoteRepository();
        const repositoryClone = getRepositoryCloneOperation({
            registry: makeProviderRegistry(makeCloneTargetDescription(remotePath)),
            runCommand: async (request) => {
                const destinationArg = request.args[3];
                if (typeof destinationArg !== 'string') {
                    throw new Error('expected clone destination argument');
                }
                mkdirSync(resolve(destinationArg, '.git'), { recursive: true });
                return { success: true, stdout: '', stderr: '', exitCode: 0 };
            },
            detectRepo: async ({ cwd }) => {
                rmSync(cwd, { recursive: true, force: true });
                return { isRepo: true, rootPath: cwd, mode: '.git' };
            },
            readSnapshot: async ({ context }) => createInMemorySnapshot(context),
        });

        const response = await cloneWithRealGitRuntime(repositoryClone, {
            context: makeContext(parent),
            request: makeRequest(parent, remotePath),
        });

        expect(response).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH,
        });
    });

    it('returns a typed failure when repository detection throws after the published destination is removed', async () => {
        const parent = createWorkspace();
        const remotePath = createBareRemoteRepository();
        const repositoryClone = getRepositoryCloneOperation({
            registry: makeProviderRegistry(makeCloneTargetDescription(remotePath)),
            runCommand: async (request) => {
                const destinationArg = request.args[3];
                if (typeof destinationArg !== 'string') {
                    throw new Error('expected clone destination argument');
                }
                mkdirSync(resolve(destinationArg, '.git'), { recursive: true });
                return { success: true, stdout: '', stderr: '', exitCode: 0 };
            },
            detectRepo: async ({ cwd }) => {
                rmSync(cwd, { recursive: true, force: true });
                throw new Error('destination disappeared during detection');
            },
            readSnapshot: async ({ context }) => createInMemorySnapshot(context),
        });

        const response = await cloneWithRealGitRuntime(repositoryClone, {
            context: makeContext(parent),
            request: makeRequest(parent, remotePath),
        });

        expect(response).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH,
        });
    });

    it('returns a typed failure when snapshot read throws after the published destination is removed', async () => {
        const parent = createWorkspace();
        const remotePath = createBareRemoteRepository();
        const repositoryClone = getRepositoryCloneOperation({
            registry: makeProviderRegistry(makeCloneTargetDescription(remotePath)),
            runCommand: async (request) => {
                const destinationArg = request.args[3];
                if (typeof destinationArg !== 'string') {
                    throw new Error('expected clone destination argument');
                }
                mkdirSync(resolve(destinationArg, '.git'), { recursive: true });
                return { success: true, stdout: '', stderr: '', exitCode: 0 };
            },
            detectRepo: async ({ cwd }) => ({ isRepo: true, rootPath: cwd, mode: '.git' }),
            readSnapshot: async ({ context }) => {
                rmSync(context.cwd, { recursive: true, force: true });
                throw new Error('destination disappeared during snapshot read');
            },
        });

        const response = await cloneWithRealGitRuntime(repositoryClone, {
            context: makeContext(parent),
            request: makeRequest(parent, remotePath),
        });

        expect(response).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH,
        });
    });

    it('rejects detection results that resolve to a parent repository instead of the clone destination', async () => {
        const parent = createWorkspace();
        const remotePath = createBareRemoteRepository();
        const repositoryClone = getRepositoryCloneOperation({
            registry: makeProviderRegistry(makeCloneTargetDescription(remotePath)),
            runCommand: async (request) => {
                const destinationArg = request.args[3];
                if (typeof destinationArg !== 'string') {
                    throw new Error('expected clone destination argument');
                }
                mkdirSync(resolve(destinationArg, '.git'), { recursive: true });
                return { success: true, stdout: '', stderr: '', exitCode: 0 };
            },
            detectRepo: async () => ({ isRepo: true, rootPath: parent, mode: '.git' }),
            readSnapshot: async ({ context }) => createInMemorySnapshot({
                ...context,
                cwd: parent,
            }),
        });

        const response = await cloneWithRealGitRuntime(repositoryClone, {
            context: makeContext(parent),
            request: makeRequest(parent, remotePath),
        });

        expect(response).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
        });
    });

    it('rejects clone roots that only match lexically when realpath cannot resolve them', async () => {
        const parent = createWorkspace();
        const remotePath = createBareRemoteRepository();
        const repositoryClone = getRepositoryCloneOperation({
            registry: makeProviderRegistry(makeCloneTargetDescription(remotePath)),
            runCommand: async (request) => {
                const destinationArg = request.args[3];
                if (typeof destinationArg !== 'string') {
                    throw new Error('expected clone destination argument');
                }
                mkdirSync(resolve(destinationArg, '.git'), { recursive: true });
                return { success: true, stdout: '', stderr: '', exitCode: 0 };
            },
            detectRepo: async ({ cwd }) => ({ isRepo: true, rootPath: `${cwd}/missing/..`, mode: '.git' }),
            readSnapshot: async ({ context }) => createInMemorySnapshot(context),
        });

        const response = await cloneWithRealGitRuntime(repositoryClone, {
            context: makeContext(parent),
            request: makeRequest(parent, remotePath),
        });

        expect(response).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
        });
    });

    it('rejects snapshots that resolve to a parent repository instead of the clone destination', async () => {
        const parent = createWorkspace();
        const remotePath = createBareRemoteRepository();
        const repositoryClone = getRepositoryCloneOperation({
            registry: makeProviderRegistry(makeCloneTargetDescription(remotePath)),
            runCommand: async (request) => {
                const destinationArg = request.args[3];
                if (typeof destinationArg !== 'string') {
                    throw new Error('expected clone destination argument');
                }
                mkdirSync(resolve(destinationArg, '.git'), { recursive: true });
                return { success: true, stdout: '', stderr: '', exitCode: 0 };
            },
            detectRepo: async ({ cwd }) => ({ isRepo: true, rootPath: cwd, mode: '.git' }),
            readSnapshot: async ({ context }) => createInMemorySnapshot({
                ...context,
                cwd: parent,
            }),
        });

        const response = await cloneWithRealGitRuntime(repositoryClone, {
            context: makeContext(parent),
            request: makeRequest(parent, remotePath),
        });

        expect(response).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
        });
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

    it('rejects symlink destination directories before running clone', async () => {
        const parent = createWorkspace();
        const remotePath = createBareRemoteRepository();
        const destination = join(parent, 'happier');
        const outside = createWorkspace();
        symlinkSync(outside, destination, 'dir');
        let cloneAttempts = 0;
        const repositoryClone = getRepositoryCloneOperation({
            registry: makeProviderRegistry(makeCloneTargetDescription(remotePath)),
            runCommand: async () => {
                cloneAttempts += 1;
                return { success: true, stdout: '', stderr: '', exitCode: 0 };
            },
        });

        const response = await cloneWithRealGitRuntime(repositoryClone, {
            context: makeContext(parent),
            request: makeRequest(parent, remotePath),
        });

        expect(response).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH,
        });
        expect(cloneAttempts).toBe(0);
        expect(existsSync(join(outside, '.git'))).toBe(false);
    });

    it('revalidates destinations changed during provider clone target discovery before running clone', async () => {
        const parent = createWorkspace();
        const remotePath = createBareRemoteRepository();
        const destination = join(parent, 'happier');
        const outside = createWorkspace();
        let cloneAttempts = 0;
        const repositoryClone = getRepositoryCloneOperation({
            registry: {
                getProvider: () => makeCloneTargetDescription(remotePath).repository.provider,
                getAdapter: () => ({
                    describeCloneTargets: async () => {
                        symlinkSync(outside, destination, 'dir');
                        return makeCloneTargetDescription(remotePath);
                    },
                }),
            },
            runCommand: async () => {
                cloneAttempts += 1;
                return { success: true, stdout: '', stderr: '', exitCode: 0 };
            },
        });

        const response = await cloneWithRealGitRuntime(repositoryClone, {
            context: makeContext(parent),
            request: makeRequest(parent, remotePath),
        });

        expect(response).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH,
        });
        expect(cloneAttempts).toBe(0);
        expect(existsSync(join(outside, '.git'))).toBe(false);
    });
});
