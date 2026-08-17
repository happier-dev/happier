import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred } from '@/dev/testkit';

const finalizeDirectImportSessionMock = vi.hoisted(() => vi.fn());
const abortPreparedDirectImportSessionViaMachineRpcMock = vi.hoisted(() => vi.fn());

vi.mock('./directTransferImportClient', () => ({
    abortPreparedDirectImportSessionViaMachineRpc: (...args: unknown[]) =>
        abortPreparedDirectImportSessionViaMachineRpcMock(...args),
    DIRECT_IMPORT_FINALIZE_OUTCOME_INDETERMINATE_ERROR_CODE:
        'DIRECT_IMPORT_FINALIZE_OUTCOME_INDETERMINATE',
    DIRECT_IMPORT_REMOTE_COMMITTED_RESULT_UNUSABLE_ERROR_CODE:
        'DIRECT_IMPORT_REMOTE_COMMITTED_RESULT_UNUSABLE',
    finalizeDirectImportSession: (...args: unknown[]) =>
        finalizeDirectImportSessionMock(...args),
    TRANSFER_FINALIZE_RECOVERY_REQUIRED_ERROR_CODE:
        'TRANSFER_FINALIZE_RECOVERY_REQUIRED',
}));

import { createDirectTransferFinalizeRecovery } from './directTransferFinalizeRecovery';

function createRecovery(expiresAt: number) {
    return createDirectTransferFinalizeRecovery({
        machineId: 'machine-1',
        serverId: 'server-1',
        uploadId: 'upload-1',
        baseUrl: 'https://machine.example.test/direct/imports/upload-1',
        expiresAt,
        parseFinalizeResponse: (response) => response.finalized.path,
    });
}

describe('createDirectTransferFinalizeRecovery', () => {
    beforeEach(() => {
        finalizeDirectImportSessionMock.mockReset();
        abortPreparedDirectImportSessionViaMachineRpcMock.mockReset();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('lets the daemon decide whether retry finalization is live when the client clock is ahead', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(90_000);
        finalizeDirectImportSessionMock.mockResolvedValueOnce({
            success: true,
            finalized: {
                success: true,
                path: '/repo/file.txt',
                sizeBytes: 4,
            },
            sha256: 'sha256:finalized',
        });
        const recovery = createRecovery(30_000);

        await expect(recovery.invoke('retry_finalize')).resolves.toEqual({
            status: 'finalized',
            response: '/repo/file.txt',
        });
        await expect(recovery.invoke('discard_staged')).resolves.toEqual({
            status: 'finalized',
            response: '/repo/file.txt',
        });
        expect(finalizeDirectImportSessionMock).toHaveBeenCalledTimes(1);
        expect(abortPreparedDirectImportSessionViaMachineRpcMock).not.toHaveBeenCalled();
    });

    it('lets the daemon decide whether discard is live when the client clock is behind', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(10_000);
        abortPreparedDirectImportSessionViaMachineRpcMock.mockResolvedValueOnce({
            aborted: true,
        });
        const recovery = createRecovery(70_000);

        await expect(recovery.invoke('discard_staged')).resolves.toEqual({
            status: 'discarded',
        });
        await expect(recovery.invoke('retry_finalize')).resolves.toEqual({
            status: 'discarded',
        });
        expect(abortPreparedDirectImportSessionViaMachineRpcMock).toHaveBeenCalledTimes(1);
        expect(finalizeDirectImportSessionMock).not.toHaveBeenCalled();
    });

    it('settles daemon expiry or session loss once without repeating finalize or switching to abort', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(10_000);
        finalizeDirectImportSessionMock.mockRejectedValueOnce(
            new Error('Direct import request failed with status 404'),
        );
        const recovery = createRecovery(70_000);
        const expected = {
            status: 'unavailable',
            reason: 'session_unavailable',
            error: 'The staged upload is no longer available',
        };

        await expect(recovery.invoke('retry_finalize')).resolves.toEqual(expected);
        await expect(recovery.invoke('retry_finalize')).resolves.toEqual(expected);
        await expect(recovery.invoke('discard_staged')).resolves.toEqual(expected);
        expect(finalizeDirectImportSessionMock).toHaveBeenCalledTimes(1);
        expect(abortPreparedDirectImportSessionViaMachineRpcMock).not.toHaveBeenCalled();
    });

    it('keeps an indeterminate retry actionable for a later retry or discard', async () => {
        finalizeDirectImportSessionMock
            .mockResolvedValueOnce({
                success: false,
                error: 'Direct import finalize outcome is indeterminate after request issuance',
                errorCode: 'DIRECT_IMPORT_FINALIZE_OUTCOME_INDETERMINATE',
            })
            .mockResolvedValueOnce({
                success: false,
                error: 'Destination rollback is still incomplete',
                errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED',
                keepSession: true,
            });
        abortPreparedDirectImportSessionViaMachineRpcMock.mockResolvedValueOnce({
            aborted: true,
        });
        const recovery = createRecovery(70_000);

        await expect(recovery.invoke('retry_finalize')).resolves.toEqual({
            status: 'unavailable',
            reason: 'outcome_indeterminate',
            error: 'Direct import finalize outcome is indeterminate after request issuance',
        });
        expect(recovery.isActionable()).toBe(true);
        await expect(recovery.invoke('retry_finalize')).resolves.toEqual({
            status: 'recovery_required',
            error: 'Destination rollback is still incomplete',
        });
        expect(recovery.isActionable()).toBe(true);
        await expect(recovery.invoke('discard_staged')).resolves.toEqual({
            status: 'discarded',
        });
        expect(recovery.isActionable()).toBe(false);

        expect(finalizeDirectImportSessionMock).toHaveBeenCalledTimes(2);
        expect(abortPreparedDirectImportSessionViaMachineRpcMock).toHaveBeenCalledTimes(1);
    });

    it('keeps a transient discard transport failure actionable', async () => {
        abortPreparedDirectImportSessionViaMachineRpcMock
            .mockRejectedValueOnce(new Error('transport unavailable'))
            .mockResolvedValueOnce({ aborted: true });
        const recovery = createRecovery(70_000);

        await expect(recovery.invoke('discard_staged')).resolves.toEqual({
            status: 'unavailable',
            reason: 'session_unavailable',
            error: 'The staged upload could not be discarded because its session is unavailable',
        });
        expect(recovery.isActionable()).toBe(true);
        await expect(recovery.invoke('discard_staged')).resolves.toEqual({
            status: 'discarded',
        });
        expect(recovery.isActionable()).toBe(false);

        expect(abortPreparedDirectImportSessionViaMachineRpcMock).toHaveBeenCalledTimes(2);
        expect(finalizeDirectImportSessionMock).not.toHaveBeenCalled();
    });

    it('settles an authoritative discard invalidity once', async () => {
        abortPreparedDirectImportSessionViaMachineRpcMock.mockResolvedValueOnce({
            aborted: false,
        });
        const recovery = createRecovery(70_000);
        const expected = {
            status: 'unavailable',
            reason: 'session_unavailable',
            error: 'The staged upload could not be discarded because its session is unavailable',
        };

        await expect(recovery.invoke('discard_staged')).resolves.toEqual(expected);
        expect(recovery.isActionable()).toBe(false);
        await expect(recovery.invoke('discard_staged')).resolves.toEqual(expected);
        await expect(recovery.invoke('retry_finalize')).resolves.toEqual(expected);

        expect(abortPreparedDirectImportSessionViaMachineRpcMock).toHaveBeenCalledTimes(1);
        expect(finalizeDirectImportSessionMock).not.toHaveBeenCalled();
    });

    it('coalesces concurrent recovery actions without running duplicate mutations', async () => {
        const finalize = createDeferred<unknown>();
        finalizeDirectImportSessionMock.mockReturnValueOnce(finalize.promise);
        const recovery = createRecovery(70_000);

        const retry = recovery.invoke('retry_finalize');
        const discard = recovery.invoke('discard_staged');

        expect(finalizeDirectImportSessionMock).toHaveBeenCalledTimes(1);
        expect(abortPreparedDirectImportSessionViaMachineRpcMock).not.toHaveBeenCalled();

        finalize.resolve({
            success: true,
            finalized: {
                success: true,
                path: '/repo/file.txt',
                sizeBytes: 4,
            },
            sha256: 'sha256:finalized',
        });

        await expect(retry).resolves.toEqual({
            status: 'finalized',
            response: '/repo/file.txt',
        });
        await expect(discard).resolves.toEqual({
            status: 'finalized',
            response: '/repo/file.txt',
        });
    });
});
