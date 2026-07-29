import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

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
} from './repositoryCloneOperations.test-support.js';
import {
    preflightDestination,
    reserveCloneDestination,
} from './repositoryCloneDestination.js';

describe('git repository clone destination publishing', () => {
    it('clones missing destinations through a private sibling before publishing the final path', async () => {
        const parent = createWorkspace();
        const remotePath = createBareRemoteRepository();
        const destination = resolve(parent, 'happier');
        let cloneDestination: string | null = null;
        const repositoryClone = getRepositoryCloneOperation({
            registry: makeProviderRegistry(makeCloneTargetDescription(remotePath)),
            runCommand: async (request) => {
                const destinationArg = request.args[3];
                if (typeof destinationArg !== 'string') {
                    throw new Error('expected clone destination argument');
                }
                cloneDestination = destinationArg;
                mkdirSync(resolve(destinationArg, '.git'), { recursive: true });
                return { success: true, stdout: '', stderr: '', exitCode: 0 };
            },
            detectRepo: async () => ({ isRepo: true, rootPath: destination, mode: '.git' }),
            readSnapshot: async ({ context }) => createInMemorySnapshot(context),
        });

        const response = await cloneWithRealGitRuntime(repositoryClone, {
            context: makeContext(parent),
            request: makeRequest(parent, remotePath),
        });

        expect(response.success).toBe(true);
        expect(cloneDestination).not.toBe(destination);
        expect(cloneDestination?.startsWith(parent)).toBe(true);
        expect(existsSync(destination)).toBe(true);
        expect(existsSync(cloneDestination ?? '')).toBe(false);
    });

    it('does not remove a replacement private clone destination during failure cleanup', async () => {
        const parent = createWorkspace();
        const remotePath = createBareRemoteRepository();
        let privateClonePath: string | null = null;
        const repositoryClone = getRepositoryCloneOperation({
            registry: makeProviderRegistry(makeCloneTargetDescription(remotePath)),
            runCommand: async (request) => {
                const destinationArg = request.args[3];
                if (typeof destinationArg !== 'string') {
                    throw new Error('expected clone destination argument');
                }
                privateClonePath = destinationArg;
                rmSync(destinationArg, { recursive: true, force: true });
                mkdirSync(destinationArg);
                writeFileSync(join(destinationArg, 'replacement.txt'), 'do not delete\n');
                return { success: false, stdout: '', stderr: 'clone failed', exitCode: 1 };
            },
        });

        const response = await cloneWithRealGitRuntime(repositoryClone, {
            context: makeContext(parent),
            request: makeRequest(parent, remotePath),
        });

        expect(response).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
        });
        expect(privateClonePath).toBeTruthy();
        expect(existsSync(join(privateClonePath ?? '', 'replacement.txt'))).toBe(true);
    });

    it('leaves a partial private clone behind after clone command failure instead of recursively deleting by path', async () => {
        const parent = createWorkspace();
        const remotePath = createBareRemoteRepository();
        let privateClonePath: string | null = null;
        const repositoryClone = getRepositoryCloneOperation({
            registry: makeProviderRegistry(makeCloneTargetDescription(remotePath)),
            runCommand: async (request) => {
                const destinationArg = request.args[3];
                if (typeof destinationArg !== 'string') {
                    throw new Error('expected clone destination argument');
                }
                privateClonePath = destinationArg;
                mkdirSync(resolve(destinationArg, '.git'), { recursive: true });
                writeFileSync(resolve(destinationArg, 'partial.txt'), 'partial clone\n');
                return { success: false, stdout: '', stderr: 'clone failed', exitCode: 1 };
            },
        });

        const response = await cloneWithRealGitRuntime(repositoryClone, {
            context: makeContext(parent),
            request: makeRequest(parent, remotePath),
        });

        expect(response).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
        });
        expect(privateClonePath).toBeTruthy();
        expect(existsSync(resolve(privateClonePath ?? '', 'partial.txt'))).toBe(true);
    });

    it('does not publish a replacement private clone destination after clone success', async () => {
        const parent = createWorkspace();
        const remotePath = createBareRemoteRepository();
        let privateClonePath: string | null = null;
        const repositoryClone = getRepositoryCloneOperation({
            registry: makeProviderRegistry(makeCloneTargetDescription(remotePath)),
            runCommand: async (request) => {
                const destinationArg = request.args[3];
                if (typeof destinationArg !== 'string') {
                    throw new Error('expected clone destination argument');
                }
                privateClonePath = destinationArg;
                rmSync(destinationArg, { recursive: true, force: true });
                mkdirSync(destinationArg);
                writeFileSync(join(destinationArg, 'replacement.txt'), 'do not publish\n');
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
        expect(existsSync(join(parent, 'happier'))).toBe(false);
        expect(privateClonePath).toBeTruthy();
        expect(existsSync(join(privateClonePath ?? '', 'replacement.txt'))).toBe(true);
    });

    it('does not overwrite an empty final destination directory created before publish', async () => {
        const parent = createWorkspace();
        const remotePath = createBareRemoteRepository();
        const destination = resolve(parent, 'happier');
        const repositoryClone = getRepositoryCloneOperation({
            registry: makeProviderRegistry(makeCloneTargetDescription(remotePath)),
            runCommand: async (request) => {
                const destinationArg = request.args[3];
                if (typeof destinationArg !== 'string') {
                    throw new Error('expected clone destination argument');
                }
                mkdirSync(resolve(destinationArg, '.git'), { recursive: true });
                mkdirSync(destination);
                return { success: true, stdout: '', stderr: '', exitCode: 0 };
            },
            detectRepo: async ({ cwd }) => ({ isRepo: true, rootPath: cwd, mode: '.git' }),
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
        expect(existsSync(destination)).toBe(true);
        expect(existsSync(resolve(destination, '.git'))).toBe(false);
    });

    it('rejects symlink parent directories before running clone', async () => {
        const selectedParent = createWorkspace();
        const actualParent = createWorkspace();
        const remotePath = createBareRemoteRepository();
        const symlinkParent = resolve(selectedParent, 'link-parent');
        symlinkSync(actualParent, symlinkParent, 'dir');
        let cloneAttempts = 0;
        const repositoryClone = getRepositoryCloneOperation({
            registry: makeProviderRegistry(makeCloneTargetDescription(remotePath)),
            runCommand: async () => {
                cloneAttempts += 1;
                return { success: true, stdout: '', stderr: '', exitCode: 0 };
            },
        });

        const response = await cloneWithRealGitRuntime(repositoryClone, {
            context: makeContext(selectedParent),
            request: makeRequest(symlinkParent, remotePath),
        });

        expect(response).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH,
        });
        expect(cloneAttempts).toBe(0);
        expect(existsSync(resolve(actualParent, 'happier'))).toBe(false);
    });

    it('rejects parent directories replaced by symlinks before private destination reservation', async () => {
        const selectedParent = createWorkspace();
        const actualParent = createWorkspace();
        const remotePath = createBareRemoteRepository();
        const destination = await preflightDestination(makeRequest(selectedParent, remotePath));
        if (!destination.ok) throw new Error(destination.response.error);
        rmSync(selectedParent, { recursive: true, force: true });
        symlinkSync(actualParent, selectedParent, 'dir');

        const reservation = await reserveCloneDestination(destination);

        expect(reservation).toMatchObject({
            ok: false,
            response: {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH,
            },
        });
        expect(existsSync(resolve(actualParent, 'happier'))).toBe(false);
    });

    it('removes its empty final reservation when publish fails before moving clone entries', async () => {
        const parent = createWorkspace();
        const remotePath = createBareRemoteRepository();
        const destination = resolve(parent, 'happier');
        const repositoryClone = getRepositoryCloneOperation({
            registry: makeProviderRegistry(makeCloneTargetDescription(remotePath)),
            runCommand: async (request) => {
                const destinationArg = request.args[3];
                if (typeof destinationArg !== 'string') {
                    throw new Error('expected clone destination argument');
                }
                writeFileSync(
                    resolve(destinationArg, `.happier-clone-publish-${basename(destinationArg)}`),
                    'clone entry collides with publish reservation marker\n',
                );
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
        expect(existsSync(destination)).toBe(false);
    });

    it('does not leave moved clone entries in the final destination when publish fails mid-transfer', async () => {
        const parent = createWorkspace();
        const remotePath = createBareRemoteRepository();
        const destination = resolve(parent, 'happier');
        const repositoryClone = getRepositoryCloneOperation({
            registry: makeProviderRegistry(makeCloneTargetDescription(remotePath)),
            runCommand: async (request) => {
                const destinationArg = request.args[3];
                if (typeof destinationArg !== 'string') {
                    throw new Error('expected clone destination argument');
                }
                writeFileSync(resolve(destinationArg, '.aaa-first'), 'moved before failure\n');
                writeFileSync(
                    resolve(destinationArg, `.happier-clone-publish-${basename(destinationArg)}`),
                    'collides after one moved entry\n',
                );
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
        expect(existsSync(resolve(destination, '.aaa-first'))).toBe(false);
    });

    it('does not treat a replacement private clone destination as a successful clone after publish', async () => {
        const parent = createWorkspace();
        const remotePath = createBareRemoteRepository();
        let privateClonePath: string | null = null;
        const repositoryClone = getRepositoryCloneOperation({
            registry: makeProviderRegistry(makeCloneTargetDescription(remotePath)),
            runCommand: async (request) => {
                const destinationArg = request.args[3];
                if (typeof destinationArg !== 'string') {
                    throw new Error('expected clone destination argument');
                }
                privateClonePath = destinationArg;
                mkdirSync(resolve(destinationArg, '.git'), { recursive: true });
                writeFileSync(join(destinationArg, 'original.txt'), 'original clone\n');
                return { success: true, stdout: '', stderr: '', exitCode: 0 };
            },
            detectRepo: async () => {
                if (!privateClonePath) {
                    throw new Error('expected clone path');
                }
                rmSync(resolve(parent, 'happier'), { recursive: true, force: true });
                mkdirSync(resolve(parent, 'happier', '.git'), { recursive: true });
                writeFileSync(resolve(parent, 'happier', 'replacement.txt'), 'replacement repo\n');
                return { isRepo: true, rootPath: resolve(parent, 'happier'), mode: '.git' };
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

});
