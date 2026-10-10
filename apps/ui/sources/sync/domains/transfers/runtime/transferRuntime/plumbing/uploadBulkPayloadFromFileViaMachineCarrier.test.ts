import { afterEach, describe, expect, it, vi } from 'vitest';

const prepareImportSessionMock = vi.hoisted(() => vi.fn());
const resolveMachineCarrierRouteMock = vi.hoisted(() => vi.fn());

// The Home profile and credential stores are device persistence boundaries;
// captureLazyActionAccountContext and its actual lifetime remain real.
vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
    const { createPartialServerProfilesModuleMock } = await import('@/dev/testkit/mocks/serverProfiles');
    return await createPartialServerProfilesModuleMock(importOriginal, { profiles: [
        { id: 'server-1', serverUrl: 'https://server-1.example.test' },
        { id: 'server-2', serverUrl: 'https://server-2.example.test' },
    ] });
});
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/auth/storage/tokenStorage')>(),
    TokenStorage: { getCredentialsForServerUrl: async () => ({ token: `header.${btoa(JSON.stringify({ sub: 'account-original' }))}.signature` }) },
}));

// Machine RPC and the carrier route/lease are the genuine network and
// transport boundaries of this owner; prepare, chunking, finalize, and the
// finalize-recovery continuation below stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc', () => ({
    callGuardedMachineRpcWithPolicy: async (params: { method: string; payload: { input?: { source?: { sourceId: string } } } }) => {
        const result = await prepareImportSessionMock(params);
        if (params.method === 'daemon.filesystem.upload' && result?.success === true && typeof result.uploadId === 'string') {
            const { success: _success, ...prepared } = result;
            return { success: true, status: 'accepted', operationId: 'upload-operation', sourceId: params.payload.input?.source?.sourceId, prepared };
        }
        return result;
    },
}));
// The carrier copy is restated instead of re-exported from the real module:
// loading it inside the factory rebinds the unmocked route resolution for the
// modules this graph already pulled in.
vi.mock('./machineCarrierHttpLease', () => ({
    MACHINE_CARRIER_INTERRUPTED_TRANSFER_ERROR: 'The direct machine connection was interrupted. Retry the transfer.',
    MACHINE_CARRIER_TRANSPORT_FAILED_ERROR_CODE: 'machine_carrier_transport_failed',
    rebaseMachineCarrierHttpEndpoint: () => {
        throw new Error('a selected browser stream carrier never rebases a native loopback origin');
    },
    resolveMachineCarrierRoute: (...args: unknown[]) => resolveMachineCarrierRouteMock(...args),
}));

import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { isTransferFinalizeRecoveryFailure } from './directTransferFinalizeRecovery';
import { uploadBulkPayloadFromFileViaMachineCarrier } from './uploadBulkPayloadFromFileViaMachineCarrier';

type FileUploadResponse = Readonly<{
    success: true;
    path: string;
    sizeBytes: number;
    sha256: string;
}>;

describe('uploadBulkPayloadFromFileViaMachineCarrier', () => {
    afterEach(() => {
        prepareImportSessionMock.mockReset();
        resolveMachineCarrierRouteMock.mockReset();
        resetRuntimeFetch();
    });

    it('scopes the finalize-recovery carrier acquisition to the recovery instead of the completed upload', async () => {
        const batch = new AbortController();
        const acquisitionSignals: Array<AbortSignal | undefined> = [];
        const finalizeCalls: string[] = [];
        const liveLeases = new Set<number>();
        let acquiredCount = 0;

        setRuntimeFetch(async () => {
            throw new Error('native fetch must not carry a selected browser machine transfer');
        });

        resolveMachineCarrierRouteMock.mockResolvedValue({
            kind: 'iroh_peer',
            serverId: 'server-1',
            carrierKind: 'browser_stream',
            acquire: async (input: Readonly<{ operationId: string; signal?: AbortSignal }>) => {
                acquisitionSignals.push(input.signal);
                if (input.signal?.aborted) {
                    // Mirrors the production browser carrier: an already aborted
                    // signal rejects the stream acquisition before admission.
                    throw Object.assign(
                        new Error('The direct machine connection was interrupted. Retry the transfer.'),
                        { errorCode: 'machine_carrier_transport_failed' },
                    );
                }
                acquiredCount += 1;
                const leaseNumber = acquiredCount;
                liveLeases.add(leaseNumber);
                return {
                    kind: 'browser_stream' as const,
                    request: async (requested: RequestInfo | URL) => {
                        if (!liveLeases.has(leaseNumber)) {
                            throw new Error('released browser machine stream');
                        }
                        const url = String(requested);
                        if (!url.includes('/finalize')) {
                            return new Response(JSON.stringify({ success: true }), {
                                status: 200,
                                headers: { 'content-type': 'application/json' },
                            });
                        }
                        finalizeCalls.push(`lease-${leaseNumber} ${url}`);
                        if (finalizeCalls.length === 1) {
                            return new Response(JSON.stringify({
                                success: false,
                                error: 'Finalize recovery is required',
                                errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED',
                                keepSession: true,
                            }), { status: 500, headers: { 'content-type': 'application/json' } });
                        }
                        return new Response(JSON.stringify({
                            success: true,
                            finalized: { success: true, path: '/repo/browser.bin', sizeBytes: 1 },
                            sha256: 'sha256:browser-recovered',
                        }), { status: 200, headers: { 'content-type': 'application/json' } });
                    },
                    release: async () => {
                        liveLeases.delete(leaseNumber);
                    },
                };
            },
        });

        prepareImportSessionMock.mockResolvedValue({
            success: true,
            uploadId: 'browser-batch-recovery-1',
            destDisplayPath: '/repo/browser.bin',
            expectedSizeBytes: 1,
            chunkSizeBytes: 1,
            recipientPublicKeyBase64: Buffer.alloc(32, 7).toString('base64'),
            expiresAt: 5_000,
            endpointCandidates: [{
                kind: 'http',
                url: 'http://127.0.0.1:46001/machine-transfers/direct/imports/browser-batch-recovery-1?grant=kept',
                expiresAt: 5_000,
            }],
        });

        const result = await uploadBulkPayloadFromFileViaMachineCarrier<FileUploadResponse>({
            machineId: 'machine-1',
            serverId: 'server-1',
            fileReader: {
                sizeBytes: 1,
                readBytes: async () => new Uint8Array([7]),
                close: async () => undefined,
            },
            directImportRequest: {
                t: 'session_file_upload_v1',
                workingDirectory: '/repo',
                path: '/repo/browser.bin',
                sizeBytes: 1,
                overwrite: true,
            },
            signal: batch.signal,
        });

        if (!isTransferFinalizeRecoveryFailure<FileUploadResponse>(result)) {
            throw new Error(`expected a finalize recovery continuation, received ${JSON.stringify(result)}`);
        }
        expect(liveLeases.size).toBe(0);

        // Another file of the same workspace batch fails and cancels the shared
        // controller while this continuation still owns the nondismissible
        // recovery modal. The staged session stays actionable.
        batch.abort(new Error('another upload in the batch failed'));
        expect(result.recovery.isActionable()).toBe(true);

        await expect(result.recovery.invoke('retry_finalize')).resolves.toEqual({
            status: 'finalized',
            response: {
                success: true,
                path: '/repo/browser.bin',
                sizeBytes: 1,
                sha256: 'sha256:browser-recovered',
            },
        });
        // The live upload keeps this operation's cancellation; the deferred
        // recovery acquisition never carries the completed batch signal.
        expect(acquisitionSignals[0]?.aborted).toBe(true);
        expect(acquisitionSignals).toHaveLength(2);
        expect(acquisitionSignals[1]).not.toBe(acquisitionSignals[0]);
        expect(acquisitionSignals[1]?.aborted ?? false).toBe(false);
        expect(finalizeCalls).toEqual([
            'lease-1 http://127.0.0.1:46001/machine-transfers/direct/imports/browser-batch-recovery-1/finalize?grant=kept',
            'lease-2 http://127.0.0.1:46001/machine-transfers/direct/imports/browser-batch-recovery-1/finalize?grant=kept',
        ]);
        expect(liveLeases.size).toBe(0);
    });
});
