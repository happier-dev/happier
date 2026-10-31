import { describe, expect, it, vi } from 'vitest';

import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/scm';

import { runWithGitScmCommandRunner, type GitScmCommandRunner } from '../testkit/scmRuntime.test-support.js';

const runScmCommand = vi.fn<GitScmCommandRunner>();

describe('git publish and stash operation safety', () => {
    it('rejects option-like remotes before publish', async () => runWithGitScmCommandRunner(runScmCommand, async () => {
        runScmCommand.mockReset();

        const { gitRemotePublish } = await import('./publishOperations.js');

        const result = await gitRemotePublish({
            context: { cwd: '/tmp' } as any,
            request: { remote: '--force' } as any,
        });

        expect(result.success).toBe(false);
        expect(result.errorCode).toBe(SCM_OPERATION_ERROR_CODES.INVALID_REQUEST);
        expect(runScmCommand).not.toHaveBeenCalled();
    }), 30_000);

    it('rejects option-like stash refs before apply-like operations', async () => runWithGitScmCommandRunner(runScmCommand, async () => {
        runScmCommand.mockReset();

        const { gitStashApply, gitStashDrop, gitStashPop, gitStashShow } = await import('./stashOperations.js');

        await expect(gitStashDrop({ context: { cwd: '/tmp' } as any, request: { stashRef: '--all' } as any })).resolves.toEqual(
            expect.objectContaining({
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            }),
        );
        await expect(gitStashPop({ context: { cwd: '/tmp' } as any, request: { stashRef: '--all' } as any })).resolves.toEqual(
            expect.objectContaining({
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            }),
        );
        await expect(gitStashApply({ context: { cwd: '/tmp' } as any, request: { stashRef: '--all' } as any })).resolves.toEqual(
            expect.objectContaining({
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            }),
        );
        await expect(
            gitStashShow({ context: { cwd: '/tmp' } as any, request: { stashRef: '--all', maxBytes: 1024 } as any }),
        ).resolves.toEqual(
            expect.objectContaining({
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            }),
        );

        expect(runScmCommand).not.toHaveBeenCalled();
    }));
});
