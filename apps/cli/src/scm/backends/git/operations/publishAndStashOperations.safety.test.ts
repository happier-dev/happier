import { describe, expect, it, vi } from 'vitest';

import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

const runScmCommand = vi.fn();

vi.mock('../../../runtime', () => ({
    runScmCommand,
}));

describe('git publish and stash operation safety', () => {
    it('rejects option-like remotes before publish', async () => {
        vi.resetModules();
        runScmCommand.mockReset();

        const { gitRemotePublish } = await import('./publishOperations');

        const result = await gitRemotePublish({
            context: { cwd: '/tmp' } as any,
            request: { remote: '--force' } as any,
        });

        expect(result.success).toBe(false);
        expect(result.errorCode).toBe(SCM_OPERATION_ERROR_CODES.INVALID_REQUEST);
        expect(runScmCommand).not.toHaveBeenCalled();
    });

    it('rejects option-like stash refs before apply-like operations', async () => {
        vi.resetModules();
        runScmCommand.mockReset();

        const { gitStashApply, gitStashDrop, gitStashPop, gitStashShow } = await import('./stashOperations');

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
    });
});
