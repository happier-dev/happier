import { describe, expect, it, vi } from 'vitest';

import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import { installScmOperationsCommonModuleMocks } from './scmOperationsTestHelpers';

const modalConfirm = vi.hoisted(() => vi.fn());

installScmOperationsCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                confirm: modalConfirm,
            },
        }).module;
    },
});

const lockFailure = {
    success: false,
    errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
    error: "fatal: Unable to create '/repo/.git/index.lock': File exists.",
} as const;

describe('runScmOperationWithGitIndexLockRecovery', () => {
    it('prompts for confirmation when an SCM failure is recoverable index-lock contention', async () => {
        modalConfirm.mockResolvedValueOnce(false);
        const removeIndexLock = vi.fn();
        const retryOriginalOperation = vi.fn();
        const { runScmOperationWithGitIndexLockRecovery } = await import('./gitIndexLockRecovery');

        const response = await runScmOperationWithGitIndexLockRecovery({
            cwd: '/repo',
            failedResponse: lockFailure,
            removeIndexLock,
            retryOriginalOperation,
        });

        expect(response).toBe(lockFailure);
        expect(modalConfirm).toHaveBeenCalledTimes(1);
        expect(removeIndexLock).not.toHaveBeenCalled();
        expect(retryOriginalOperation).not.toHaveBeenCalled();
    });

    it('does not remove the lock or retry when confirmation is cancelled', async () => {
        modalConfirm.mockReset();
        modalConfirm.mockResolvedValueOnce(false);
        const removeIndexLock = vi.fn();
        const retryOriginalOperation = vi.fn();
        const { runScmOperationWithGitIndexLockRecovery } = await import('./gitIndexLockRecovery');

        await runScmOperationWithGitIndexLockRecovery({
            cwd: '/repo',
            failedResponse: lockFailure,
            removeIndexLock,
            retryOriginalOperation,
        });

        expect(removeIndexLock).not.toHaveBeenCalled();
        expect(retryOriginalOperation).not.toHaveBeenCalled();
    });

    it('confirms, removes the backend-resolved lock, and retries the original operation once', async () => {
        modalConfirm.mockReset();
        modalConfirm.mockResolvedValueOnce(true);
        const retryResponse = { success: true, stdout: 'retried' } as const;
        const removeIndexLock = vi.fn(async () => ({ success: true, removed: true, lockPath: '/repo/.git/index.lock' } as const));
        const retryOriginalOperation = vi.fn(async () => retryResponse);
        const { runScmOperationWithGitIndexLockRecovery } = await import('./gitIndexLockRecovery');

        const response = await runScmOperationWithGitIndexLockRecovery({
            cwd: '/repo',
            failedResponse: lockFailure,
            removeIndexLock,
            retryOriginalOperation,
        });

        expect(response).toBe(retryResponse);
        expect(removeIndexLock).toHaveBeenCalledWith({
            cwd: '/repo',
            confirmed: true,
            confirmationToken: 'remove-stale-index-lock',
        });
        expect(retryOriginalOperation).toHaveBeenCalledTimes(1);
    });

    it('surfaces a distinct error when removeIndexLock itself fails (does not retry)', async () => {
        modalConfirm.mockReset();
        modalConfirm.mockResolvedValueOnce(true);
        const removeIndexLock = vi.fn(async () => ({
            success: false as const,
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: 'permission denied: cannot unlink /repo/.git/index.lock',
        }));
        const retryOriginalOperation = vi.fn();
        const { runScmOperationWithGitIndexLockRecovery } = await import('./gitIndexLockRecovery');

        const response = await runScmOperationWithGitIndexLockRecovery({
            cwd: '/repo',
            failedResponse: lockFailure,
            removeIndexLock,
            retryOriginalOperation,
        });

        expect(response.success).toBe(false);
        expect((response as { error?: string }).error).toBe('files.indexLockRecovery.failed');
        expect(retryOriginalOperation).not.toHaveBeenCalled();
    });

    it('does not prompt or retry a second time when recovery was already attempted', async () => {
        modalConfirm.mockReset();
        const removeIndexLock = vi.fn();
        const retryOriginalOperation = vi.fn();
        const { runScmOperationWithGitIndexLockRecovery } = await import('./gitIndexLockRecovery');

        const response = await runScmOperationWithGitIndexLockRecovery({
            cwd: '/repo',
            failedResponse: lockFailure,
            removeIndexLock,
            retryOriginalOperation,
            recoveryAlreadyAttempted: true,
        });

        expect(response).toBe(lockFailure);
        expect(modalConfirm).not.toHaveBeenCalled();
        expect(removeIndexLock).not.toHaveBeenCalled();
        expect(retryOriginalOperation).not.toHaveBeenCalled();
    });

    it('does not prompt for non-lock SCM failures', async () => {
        modalConfirm.mockReset();
        const removeIndexLock = vi.fn();
        const retryOriginalOperation = vi.fn();
        const { runScmOperationWithGitIndexLockRecovery } = await import('./gitIndexLockRecovery');

        const response = await runScmOperationWithGitIndexLockRecovery({
            cwd: '/repo',
            failedResponse: {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_REJECTED,
                error: 'remote rejected',
            },
            removeIndexLock,
            retryOriginalOperation,
        });

        expect(response.success).toBe(false);
        expect(modalConfirm).not.toHaveBeenCalled();
        expect(removeIndexLock).not.toHaveBeenCalled();
        expect(retryOriginalOperation).not.toHaveBeenCalled();
    });
});
