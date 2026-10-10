import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred } from '@/dev/testkit';

const finalizeDirectImportSessionMock = vi.hoisted(() => vi.fn());
const abortPreparedDirectImportSessionViaMachineRpcMock = vi.hoisted(() => vi.fn());

// Only the two network operations are replaced; the carrier request rule stays
// real so a retry's endpoint resolution is exercised rather than restated here.
vi.mock('./directTransferImportClient', async (importOriginal) => ({
    ...await importOriginal<typeof import('./directTransferImportClient')>(),
    abortPreparedDirectImportSessionViaMachineRpc: (...args: unknown[]) =>
        abortPreparedDirectImportSessionViaMachineRpcMock(...args),
    finalizeDirectImportSession: (...args: unknown[]) =>
        finalizeDirectImportSessionMock(...args),
}));

import { createDirectTransferFinalizeRecovery } from './directTransferFinalizeRecovery';
import type { MachineCarrierHttpLease } from './machineCarrierHttpLease';

function createRecovery(
    expiresAt: number,
    acquireCarrier?: (prepared: Readonly<{ operationId: string }>) => Promise<MachineCarrierHttpLease | null>,
) {
    return createDirectTransferFinalizeRecovery({
        machineId: 'machine-1',
        serverId: 'server-1',
        uploadId: 'upload-1',
        baseUrl: 'https://machine.example.test/direct/imports/upload-1',
        expiresAt,
        ...(acquireCarrier ? { acquireCarrier } : {}),
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

    it('retains the captured Account until settlement and refuses a retired Account before any retry or discard effect', async () => {
        let current = true;
        let custodyReleased = false;
        const recovery = createDirectTransferFinalizeRecovery({ machineId: 'machine-1', serverId: 'server-1', accountId: 'account-original',
            accountLifetime: { scope: { serverId: 'server-1', accountId: 'account-original' }, isCurrent: () => current,
                onRetire: () => ({ dispose: () => {} }) }, onSettled: () => { custodyReleased = true; },
            uploadId: 'upload-1', baseUrl: 'https://machine.example.test/imports/upload-1', expiresAt: 70_000,
            parseFinalizeResponse: response => response.finalized.path });
        expect(recovery.isActionable()).toBe(true); expect(custodyReleased).toBe(false);
        current = false;
        await expect(recovery.invoke('retry_finalize')).resolves.toMatchObject({ status: 'unavailable', reason: 'session_unavailable' });
        expect(custodyReleased).toBe(true);
        expect(recovery.isActionable()).toBe(false);
        await recovery.invoke('discard_staged');
        expect(finalizeDirectImportSessionMock).not.toHaveBeenCalled();
        expect(abortPreparedDirectImportSessionViaMachineRpcMock).not.toHaveBeenCalled();
    });

    it('rebases the prepared endpoint onto a carrier reacquired for each retry', async () => {
        // The upload hands carrier custody back before this continuation exists,
        // so the origin captured with the prepared endpoint is already dead.
        const held: string[] = [];
        let leases = 0;
        const acquireCarrier = async (prepared: Readonly<{ operationId: string }>) => {
            leases += 1;
            const localOrigin = `http://127.0.0.1:${49000 + leases}`;
            held.push(`${prepared.operationId}@${localOrigin}`);
            return {
                kind: 'native_http' as const,
                localOrigin,
                release: async () => {
                    held.splice(held.indexOf(`${prepared.operationId}@${localOrigin}`), 1);
                },
            } satisfies MachineCarrierHttpLease;
        };
        finalizeDirectImportSessionMock
            .mockResolvedValueOnce({
                success: false,
                error: 'Destination rollback is still incomplete',
                errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED',
                keepSession: true,
            })
            .mockResolvedValueOnce({
                success: true,
                finalized: { success: true, path: '/repo/file.txt', sizeBytes: 4 },
                sha256: 'sha256:finalized',
            });
        const recovery = createRecovery(70_000, acquireCarrier);

        await expect(recovery.invoke('retry_finalize')).resolves.toEqual({
            status: 'recovery_required',
            error: 'Destination rollback is still incomplete',
        });
        await expect(recovery.invoke('retry_finalize')).resolves.toEqual({
            status: 'finalized',
            response: '/repo/file.txt',
        });

        expect(finalizeDirectImportSessionMock.mock.calls.map(([call]) => (call as { baseUrl: string }).baseUrl)).toEqual([
            'http://127.0.0.1:49001/direct/imports/upload-1',
            'http://127.0.0.1:49002/direct/imports/upload-1',
        ]);
        expect(held).toEqual([]);
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
