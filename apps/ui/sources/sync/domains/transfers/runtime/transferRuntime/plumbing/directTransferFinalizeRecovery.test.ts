import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
});
