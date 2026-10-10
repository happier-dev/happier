import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const prepareImportSessionMock = vi.hoisted(() => vi.fn());

function readHeadersRecord(headers: HeadersInit | undefined): Record<string, string> {
    return Object.fromEntries(new Headers(headers).entries()) as Record<string, string>;
}

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc', () => ({
    callGuardedMachineRpcWithPolicy: async (params: { method: string; payload: { input?: { source?: { sourceId: string } } } }) => {
        const result = await prepareImportSessionMock(params);
        // Existing byte/transport vectors now model the semantic Action wire
        // envelope; unrelated prepared import families retain their own DTO.
        if (params.method === 'daemon.filesystem.upload' && result?.success === true && typeof result.uploadId === 'string') {
            const { success: _success, ...prepared } = result;
            return { success: true, status: 'accepted', operationId: 'upload-operation', sourceId: params.payload.input?.source?.sourceId, prepared };
        }
        if (params.method === 'daemon.filesystem.transfer.cancel' && result?.success === true) return { success: true, aborted: true };
        return result;
    },
}));

import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { isTransferFinalizeRecoveryFailure } from './directTransferFinalizeRecovery';
import { uploadBulkPayloadFromFileViaDirectImport } from './directTransferImportUpload';
import {
    createTransferRecipientKeyPair,
} from './transferChunkEncryption';

describe('uploadBulkPayloadFromFileViaDirectImport', () => {
    afterEach(() => {
        prepareImportSessionMock.mockReset();
        resetRuntimeFetch();
    });

    it('cleans failed filesystem byte custody through its actual prepared HTTP capability without another cancel Action', async () => {
        prepareImportSessionMock.mockResolvedValue({ success: true, uploadId: 'owned-import', destDisplayPath: '/repo/file',
            expectedSizeBytes: 1, chunkSizeBytes: 1, recipientPublicKeyBase64: Buffer.alloc(32, 7).toString('base64'), expiresAt: 5000,
            endpointCandidates: [{ kind: 'http', url: 'http://127.0.0.1:46001/machine-transfers/direct/imports/owned-import', expiresAt: 5000 }] });
        const effects: string[] = [];
        setRuntimeFetch(async (request, init) => {
            effects.push(`${init?.method} ${String(request)}`);
            if (!String(request).endsWith('/owned-import/abort')) throw new Error('Unexpected data-plane effect');
            return Response.json({ success: true });
        });
        await expect(uploadBulkPayloadFromFileViaDirectImport({ machineId: 'machine-1', serverId: 'server-1',
            fileReader: { sizeBytes: 1, readBytes: async () => { throw new Error('Actual source reader failed'); }, close: async () => {} },
            request: { t: 'session_file_upload_v1', workingDirectory: '/repo', path: 'file', sizeBytes: 1, overwrite: false },
        })).resolves.toMatchObject({ success: false });
        expect(effects).toEqual(['POST http://127.0.0.1:46001/machine-transfers/direct/imports/owned-import/abort']);
        expect(prepareImportSessionMock.mock.calls.map(([request]) => request.method)).toEqual(['daemon.filesystem.upload']);
    });

    it('reports only the shape of an unsupported prepare response', async () => {
        prepareImportSessionMock.mockResolvedValue({
            ok: true,
            result: { secret: 'must-not-leak' },
        });

        const result = await uploadBulkPayloadFromFileViaDirectImport({
            machineId: 'machine-1',
            serverId: 'server-1',
            fileReader: {
                sizeBytes: 1,
                readBytes: async () => new Uint8Array([1]),
                close: async () => {},
            },
            request: {
                t: 'session_file_upload_v1',
                workingDirectory: '/repo',
                path: 'payload.bin',
                sizeBytes: 1,
                overwrite: true,
            },
        });

        expect(result).toMatchObject({
            success: false,
            errorCode: 'DIRECT_IMPORT_PREPARE_INVALID',
            error: 'Direct import prepare returned an unsupported response (shape: object; success=undefined; error=undefined; ok=boolean; result=object)',
        });
        expect(JSON.stringify(result)).not.toContain('must-not-leak');
    });

    it('prepares a direct import session and uploads encrypted chunks through the HTTP transfer endpoints', async () => {
        const order: string[] = [];
        const release = vi.fn(async () => {});
        const acquirePreparedCarrier = vi.fn(async () => {
            order.push('lease');
            return {
                kind: 'native_http' as const,
                localOrigin: 'http://127.0.0.1:48123',
                release,
            };
        });
        const requests: Array<Readonly<{
            method: string;
            url: string;
            headers: Record<string, string>;
        }>> = [];

        prepareImportSessionMock.mockImplementation(async () => {
            order.push('prepare');
            return {
            success: true,
            uploadId: 'upload-1',
            destDisplayPath: '/repo/payload.bin',
            expectedSizeBytes: 5,
            chunkSizeBytes: 2,
            recipientPublicKeyBase64: Buffer.alloc(32, 7).toString('base64'),
            expiresAt: 5_000,
            endpointCandidates: [
                {
                    kind: 'http',
                    url: 'http://127.0.0.1:46001/machine-transfers/direct/imports/upload-1',
                    expiresAt: 5_000,
                },
            ],
            };
        });

        setRuntimeFetch(async (input, init) => {
            const url = input instanceof URL ? input.toString() : String(input);
            const method = String(init?.method ?? 'GET');
            requests.push({
                method,
                url,
                headers: readHeadersRecord(init?.headers),
            });
            order.push('transfer');

            if (url.includes('/chunks/') && method === 'PUT') {
                return new Response(JSON.stringify({ success: true }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }

            if (url.endsWith('/finalize') && method === 'POST') {
                return new Response(JSON.stringify({
                    success: true,
                    finalized: {
                        success: true,
                        path: '/repo/payload.bin',
                        sizeBytes: 5,
                    },
                    sha256: 'sha256:test',
                }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }

            throw new Error(`unexpected request: ${method} ${url}`);
        });

        const result = await uploadBulkPayloadFromFileViaDirectImport({
            machineId: 'machine-1',
            serverId: 'server-1',
            fileReader: {
                sizeBytes: 5,
                readBytes: async (offset, length) => new TextEncoder().encode('hello').subarray(offset, offset + length),
                close: async () => {},
            },
            request: {
                t: 'session_file_upload_v1',
                workingDirectory: '/repo',
                path: '/repo/payload.bin',
                sizeBytes: 5,
                overwrite: true,
            },
            acquirePreparedCarrier,
        });

        expect(result).toEqual({
            success: true,
            path: '/repo/payload.bin',
            sizeBytes: 5,
            sha256: 'sha256:test',
        });
        expect(prepareImportSessionMock).toHaveBeenCalledTimes(1);
        expect(prepareImportSessionMock).toHaveBeenCalledWith(expect.objectContaining({
            method: 'daemon.filesystem.upload',
        }));
        expect(acquirePreparedCarrier).toHaveBeenCalledWith({ operationId: 'upload-1' });
        expect(order.slice(0, 3)).toEqual(['prepare', 'lease', 'transfer']);
        expect(release).toHaveBeenCalledTimes(1);
        expect(requests).toEqual([
            {
                method: 'PUT',
                url: 'http://127.0.0.1:48123/machine-transfers/direct/imports/upload-1/chunks/0',
                headers: {
                    'content-type': 'application/json',
                },
            },
            {
                method: 'PUT',
                url: 'http://127.0.0.1:48123/machine-transfers/direct/imports/upload-1/chunks/1',
                headers: {
                    'content-type': 'application/json',
                },
            },
            {
                method: 'PUT',
                url: 'http://127.0.0.1:48123/machine-transfers/direct/imports/upload-1/chunks/2',
                headers: {
                    'content-type': 'application/json',
                },
            },
            {
                method: 'POST',
                url: 'http://127.0.0.1:48123/machine-transfers/direct/imports/upload-1/finalize',
                headers: {},
            },
        ]);
    });

    it('carries upload requests through a browser machine stream without using native fetch', async () => {
        prepareImportSessionMock.mockResolvedValueOnce({
            success: true,
            uploadId: 'browser-upload-1',
            destDisplayPath: '/repo/browser.bin',
            expectedSizeBytes: 1,
            chunkSizeBytes: 1,
            recipientPublicKeyBase64: Buffer.alloc(32, 7).toString('base64'),
            expiresAt: 5_000,
            endpointCandidates: [{
                kind: 'http',
                url: 'http://127.0.0.1:46001/machine-transfers/direct/imports/browser-upload-1?grant=kept',
                expiresAt: 5_000,
            }],
        });
        setRuntimeFetch(async () => {
            throw new Error('native fetch must not carry a selected browser machine transfer');
        });
        const requests: Array<Readonly<{ url: string; method: string }>> = [];
        const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            requests.push({ url, method: String(init?.method ?? 'GET') });
            if (url.includes('/finalize')) {
                return new Response(JSON.stringify({
                    success: true,
                    finalized: { success: true, path: '/repo/browser.bin', sizeBytes: 1 },
                    sha256: 'sha256:browser',
                }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            return new Response(JSON.stringify({ success: true }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        });
        const release = vi.fn(async () => undefined);

        const result = await uploadBulkPayloadFromFileViaDirectImport({
            machineId: 'machine-1',
            serverId: 'server-1',
            fileReader: {
                sizeBytes: 1,
                readBytes: async () => new Uint8Array([7]),
                close: async () => undefined,
            },
            request: {
                t: 'session_file_upload_v1',
                workingDirectory: '/repo',
                path: '/repo/browser.bin',
                sizeBytes: 1,
                overwrite: true,
            },
            acquirePreparedCarrier: async () => ({ kind: 'browser_stream', request, release }),
        });

        expect(result).toMatchObject({ success: true, path: '/repo/browser.bin', sizeBytes: 1 });
        expect(requests).toEqual([
            {
                url: 'http://127.0.0.1:46001/machine-transfers/direct/imports/browser-upload-1/chunks/0?grant=kept',
                method: 'PUT',
            },
            {
                url: 'http://127.0.0.1:46001/machine-transfers/direct/imports/browser-upload-1/finalize?grant=kept',
                method: 'POST',
            },
        ]);
        expect(release).toHaveBeenCalledTimes(1);
    });

    it('owns the terminal selected-Iroh failure after a browser carrier request fails', async () => {
        prepareImportSessionMock.mockImplementation(async ({ method }: { method: string }) => method === RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_ABORT
            ? { success: true, aborted: true }
            : ({
            success: true,
            uploadId: 'browser-upload-failed',
            destDisplayPath: '/repo/browser.bin',
            expectedSizeBytes: 1,
            chunkSizeBytes: 1,
            recipientPublicKeyBase64: Buffer.alloc(32, 7).toString('base64'),
            expiresAt: 5_000,
            endpointCandidates: [{
                kind: 'http',
                url: 'http://127.0.0.1:46001/machine-transfers/direct/imports/browser-upload-failed',
                expiresAt: 5_000,
            }],
        }));
        const release = vi.fn(async () => undefined);

        const result = await uploadBulkPayloadFromFileViaDirectImport({
            machineId: 'machine-1',
            serverId: 'server-1',
            fileReader: {
                sizeBytes: 1,
                readBytes: async () => new Uint8Array([7]),
                close: async () => undefined,
            },
            request: {
                t: 'session_file_upload_v1',
                workingDirectory: '/repo',
                path: '/repo/browser.bin',
                sizeBytes: 1,
                overwrite: true,
            },
            acquirePreparedCarrier: async () => ({
                kind: 'browser_stream',
                request: async (input) => {
                    if (String(input).endsWith('/abort')) return Response.json({ success: true, aborted: true });
                    throw new Error('selected Iroh stream failed');
                },
                release,
            }),
        });

        expect(result).toEqual({
            success: false,
            error: 'The direct machine connection was interrupted. Retry the transfer.',
            errorCode: 'machine_carrier_transport_failed',
        });
        expect(release).toHaveBeenCalledTimes(1);
    });

    it('uses the daemon-refreshed retained-session expiry for finalize recovery', async () => {
        const preparedExpiresAt = Date.now() + 1_000;
        const refreshedExpiresAt = Date.now() + 60_000;
        prepareImportSessionMock.mockResolvedValue({
            success: true,
            uploadId: 'upload-recovery-expiry',
            destDisplayPath: '/repo/payload.bin',
            expectedSizeBytes: 5,
            chunkSizeBytes: 5,
            recipientPublicKeyBase64: Buffer.alloc(32, 7).toString('base64'),
            expiresAt: preparedExpiresAt,
            endpointCandidates: [{
                kind: 'http',
                url: 'http://127.0.0.1:46001/machine-transfers/direct/imports/upload-recovery-expiry',
                expiresAt: preparedExpiresAt,
            }],
        });
        setRuntimeFetch(async (input, init) => {
            const url = String(input);
            if (url.endsWith('/chunks/0') && init?.method === 'PUT') {
                return new Response(JSON.stringify({ success: true }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            if (url.endsWith('/finalize') && init?.method === 'POST') {
                return new Response(JSON.stringify({
                    success: false,
                    error: 'Finalize recovery is required',
                    errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED',
                    keepSession: true,
                }), {
                    status: 500,
                    headers: {
                        'content-type': 'application/json',
                        'x-happier-transfer-session-expires-at': String(refreshedExpiresAt),
                    },
                });
            }
            throw new Error(`unexpected request: ${String(init?.method)} ${url}`);
        });

        const result = await uploadBulkPayloadFromFileViaDirectImport({
            machineId: 'machine-1',
            fileReader: {
                sizeBytes: 5,
                readBytes: async () => new TextEncoder().encode('hello'),
                close: async () => {},
            },
            request: {
                t: 'session_file_upload_v1',
                workingDirectory: '/repo',
                path: '/repo/payload.bin',
                sizeBytes: 5,
                overwrite: true,
            },
        });

        expect(result).toMatchObject({
            success: false,
            errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED',
            recovery: {
                expiresAt: refreshedExpiresAt,
            },
        });
    });

    it('reacquires the pinned native carrier for a finalize recovery retry instead of the released loopback origin', async () => {
        type FileUploadResponse = Readonly<{
            success: true;
            path: string;
            sizeBytes: number;
            sha256: string;
        }>;
        const finalizeUrls: string[] = [];
        const acquiredOperationIds: string[] = [];
        // A native lease owns an ephemeral loopback listener that ends with it.
        const liveOrigins = new Set<string>();
        let acquiredCount = 0;
        const acquirePreparedCarrier = vi.fn(async (prepared: Readonly<{ operationId: string }>) => {
            acquiredOperationIds.push(prepared.operationId);
            const localOrigin = `http://127.0.0.1:${48123 + acquiredCount}`;
            acquiredCount += 1;
            liveOrigins.add(localOrigin);
            return {
                kind: 'native_http' as const,
                localOrigin,
                release: async () => {
                    liveOrigins.delete(localOrigin);
                },
            };
        });

        prepareImportSessionMock.mockResolvedValue({
            success: true,
            uploadId: 'upload-recovery-carrier',
            destDisplayPath: '/repo/payload.bin',
            expectedSizeBytes: 5,
            chunkSizeBytes: 5,
            recipientPublicKeyBase64: Buffer.alloc(32, 7).toString('base64'),
            expiresAt: 5_000,
            endpointCandidates: [{
                kind: 'http',
                url: 'http://127.0.0.1:46001/machine-transfers/direct/imports/upload-recovery-carrier',
                expiresAt: 5_000,
            }],
        });
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            if (!liveOrigins.has(url.origin)) {
                throw new TypeError('Failed to fetch');
            }
            if (url.pathname.endsWith('/chunks/0') && init?.method === 'PUT') {
                return new Response(JSON.stringify({ success: true }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            if (url.pathname.endsWith('/finalize') && init?.method === 'POST') {
                finalizeUrls.push(url.toString());
                if (finalizeUrls.length === 1) {
                    return new Response(JSON.stringify({
                        success: false,
                        error: 'Finalize recovery is required',
                        errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED',
                        keepSession: true,
                    }), { status: 500, headers: { 'content-type': 'application/json' } });
                }
                return new Response(JSON.stringify({
                    success: true,
                    finalized: { success: true, path: '/repo/payload.bin', sizeBytes: 5 },
                    sha256: 'sha256:recovered',
                }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            throw new Error(`unexpected request: ${String(init?.method)} ${url.toString()}`);
        });

        const result = await uploadBulkPayloadFromFileViaDirectImport<FileUploadResponse>({
            machineId: 'machine-1',
            serverId: 'server-1',
            fileReader: {
                sizeBytes: 5,
                readBytes: async () => new TextEncoder().encode('hello'),
                close: async () => {},
            },
            request: {
                t: 'session_file_upload_v1',
                workingDirectory: '/repo',
                path: '/repo/payload.bin',
                sizeBytes: 5,
                overwrite: true,
            },
            acquirePreparedCarrier,
        });

        if (!isTransferFinalizeRecoveryFailure<FileUploadResponse>(result)) {
            throw new Error(`expected a finalize recovery continuation, received ${JSON.stringify(result)}`);
        }
        expect(liveOrigins.size).toBe(0);

        await expect(result.recovery.invoke('retry_finalize')).resolves.toEqual({
            status: 'finalized',
            response: {
                success: true,
                path: '/repo/payload.bin',
                sizeBytes: 5,
                sha256: 'sha256:recovered',
            },
        });
        expect(acquiredOperationIds).toEqual(['upload-recovery-carrier', 'upload-recovery-carrier']);
        expect(finalizeUrls).toEqual([
            'http://127.0.0.1:48123/machine-transfers/direct/imports/upload-recovery-carrier/finalize',
            'http://127.0.0.1:48124/machine-transfers/direct/imports/upload-recovery-carrier/finalize',
        ]);
        expect(liveOrigins.size).toBe(0);
    });

    it('reacquires the browser machine carrier requester for a finalize recovery retry', async () => {
        type FileUploadResponse = Readonly<{
            success: true;
            path: string;
            sizeBytes: number;
            sha256: string;
        }>;
        setRuntimeFetch(async () => {
            throw new Error('native fetch must not carry a selected browser machine transfer');
        });
        const finalizeCalls: string[] = [];
        const liveLeases = new Set<number>();
        let acquiredCount = 0;
        const acquirePreparedCarrier = vi.fn(async () => {
            acquiredCount += 1;
            const leaseNumber = acquiredCount;
            liveLeases.add(leaseNumber);
            return {
                kind: 'browser_stream' as const,
                request: async (input: RequestInfo | URL, init?: RequestInit) => {
                    if (!liveLeases.has(leaseNumber)) {
                        throw new Error('released browser machine stream');
                    }
                    const url = String(input);
                    if (url.includes('/finalize')) {
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
                    }
                    void init;
                    return new Response(JSON.stringify({ success: true }), {
                        status: 200,
                        headers: { 'content-type': 'application/json' },
                    });
                },
                release: async () => {
                    liveLeases.delete(leaseNumber);
                },
            };
        });

        prepareImportSessionMock.mockResolvedValue({
            success: true,
            uploadId: 'browser-recovery-1',
            destDisplayPath: '/repo/browser.bin',
            expectedSizeBytes: 1,
            chunkSizeBytes: 1,
            recipientPublicKeyBase64: Buffer.alloc(32, 7).toString('base64'),
            expiresAt: 5_000,
            endpointCandidates: [{
                kind: 'http',
                url: 'http://127.0.0.1:46001/machine-transfers/direct/imports/browser-recovery-1?grant=kept',
                expiresAt: 5_000,
            }],
        });

        const result = await uploadBulkPayloadFromFileViaDirectImport<FileUploadResponse>({
            machineId: 'machine-1',
            serverId: 'server-1',
            fileReader: {
                sizeBytes: 1,
                readBytes: async () => new Uint8Array([7]),
                close: async () => undefined,
            },
            request: {
                t: 'session_file_upload_v1',
                workingDirectory: '/repo',
                path: '/repo/browser.bin',
                sizeBytes: 1,
                overwrite: true,
            },
            acquirePreparedCarrier,
        });

        if (!isTransferFinalizeRecoveryFailure<FileUploadResponse>(result)) {
            throw new Error(`expected a finalize recovery continuation, received ${JSON.stringify(result)}`);
        }
        expect(liveLeases.size).toBe(0);

        await expect(result.recovery.invoke('retry_finalize')).resolves.toEqual({
            status: 'finalized',
            response: {
                success: true,
                path: '/repo/browser.bin',
                sizeBytes: 1,
                sha256: 'sha256:browser-recovered',
            },
        });
        expect(finalizeCalls).toEqual([
            'lease-1 http://127.0.0.1:46001/machine-transfers/direct/imports/browser-recovery-1/finalize?grant=kept',
            'lease-2 http://127.0.0.1:46001/machine-transfers/direct/imports/browser-recovery-1/finalize?grant=kept',
        ]);
        expect(liveLeases.size).toBe(0);
    });

    it('keeps a finalize recovery retry actionable when the machine carrier cannot be reacquired', async () => {
        type FileUploadResponse = Readonly<{
            success: true;
            path: string;
            sizeBytes: number;
            sha256: string;
        }>;
        const finalizeAttempts: string[] = [];
        const liveOrigins = new Set<string>();
        let acquiredCount = 0;
        const acquirePreparedCarrier = vi.fn(async () => {
            acquiredCount += 1;
            if (acquiredCount > 1) {
                throw Object.assign(new Error('The direct machine connection was interrupted. Retry the transfer.'), {
                    errorCode: 'machine_carrier_transport_failed',
                });
            }
            const localOrigin = 'http://127.0.0.1:48555';
            liveOrigins.add(localOrigin);
            return {
                kind: 'native_http' as const,
                localOrigin,
                release: async () => {
                    liveOrigins.delete(localOrigin);
                },
            };
        });

        prepareImportSessionMock.mockResolvedValue({
            success: true,
            uploadId: 'upload-recovery-unreachable',
            destDisplayPath: '/repo/payload.bin',
            expectedSizeBytes: 5,
            chunkSizeBytes: 5,
            recipientPublicKeyBase64: Buffer.alloc(32, 7).toString('base64'),
            expiresAt: 5_000,
            endpointCandidates: [{
                kind: 'http',
                url: 'http://127.0.0.1:46001/machine-transfers/direct/imports/upload-recovery-unreachable',
                expiresAt: 5_000,
            }],
        });
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            if (!liveOrigins.has(url.origin)) {
                throw new TypeError('Failed to fetch');
            }
            if (url.pathname.endsWith('/chunks/0') && init?.method === 'PUT') {
                return new Response(JSON.stringify({ success: true }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            if (url.pathname.endsWith('/finalize') && init?.method === 'POST') {
                finalizeAttempts.push(url.toString());
                return new Response(JSON.stringify({
                    success: false,
                    error: 'Finalize recovery is required',
                    errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED',
                    keepSession: true,
                }), { status: 500, headers: { 'content-type': 'application/json' } });
            }
            throw new Error(`unexpected request: ${String(init?.method)} ${url.toString()}`);
        });

        const result = await uploadBulkPayloadFromFileViaDirectImport<FileUploadResponse>({
            machineId: 'machine-1',
            serverId: 'server-1',
            fileReader: {
                sizeBytes: 5,
                readBytes: async () => new TextEncoder().encode('hello'),
                close: async () => {},
            },
            request: {
                t: 'session_file_upload_v1',
                workingDirectory: '/repo',
                path: '/repo/payload.bin',
                sizeBytes: 5,
                overwrite: true,
            },
            acquirePreparedCarrier,
        });

        if (!isTransferFinalizeRecoveryFailure<FileUploadResponse>(result)) {
            throw new Error(`expected a finalize recovery continuation, received ${JSON.stringify(result)}`);
        }

        await expect(result.recovery.invoke('retry_finalize')).resolves.toEqual({
            status: 'unavailable',
            reason: 'session_unavailable',
            error: 'The direct machine connection was interrupted. Retry the transfer.',
        });
        // Nothing was issued against the staged session, so the user keeps both actions.
        expect(result.recovery.isActionable()).toBe(true);
        expect(finalizeAttempts).toHaveLength(1);
    });

    it('accepts https direct import endpoints with a Serve path prefix', async () => {
        const requests: Array<Readonly<{ method: string; url: string }>> = [];

        prepareImportSessionMock.mockResolvedValue({
            success: true,
            uploadId: 'upload-https',
            destDisplayPath: '/repo/payload.bin',
            expectedSizeBytes: 5,
            chunkSizeBytes: 2,
            recipientPublicKeyBase64: Buffer.alloc(32, 7).toString('base64'),
            expiresAt: 5_000,
            endpointCandidates: [
                {
                    kind: 'https',
                    url: 'https://example.ts.net/__happier/transfer/machine-transfers/direct/imports/upload-https',
                    expiresAt: 5_000,
                },
            ],
        });

        setRuntimeFetch(async (input, init) => {
            const url = input instanceof URL ? input.toString() : String(input);
            const method = String(init?.method ?? 'GET');
            requests.push({ method, url });

            if (url.includes('/chunks/') && method === 'PUT') {
                return new Response(JSON.stringify({ success: true }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }

            if (url.endsWith('/finalize') && method === 'POST') {
                return new Response(JSON.stringify({
                    success: true,
                    finalized: {
                        success: true,
                        path: '/repo/payload.bin',
                        sizeBytes: 5,
                    },
                    sha256: 'sha256:test',
                }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }

            throw new Error(`unexpected request: ${method} ${url}`);
        });

        const result = await uploadBulkPayloadFromFileViaDirectImport({
            machineId: 'machine-1',
            serverId: 'server-1',
            fileReader: {
                sizeBytes: 5,
                readBytes: async (offset, length) => new TextEncoder().encode('hello').subarray(offset, offset + length),
                close: async () => {},
            },
            request: {
                t: 'session_file_upload_v1',
                workingDirectory: '/repo',
                path: '/repo/payload.bin',
                sizeBytes: 5,
                overwrite: true,
            },
        });

        expect(result).toEqual({
            success: true,
            path: '/repo/payload.bin',
            sizeBytes: 5,
            sha256: 'sha256:test',
        });
        expect(requests).toEqual([
            {
                method: 'PUT',
                url: 'https://example.ts.net/__happier/transfer/machine-transfers/direct/imports/upload-https/chunks/0',
            },
            {
                method: 'PUT',
                url: 'https://example.ts.net/__happier/transfer/machine-transfers/direct/imports/upload-https/chunks/1',
            },
            {
                method: 'PUT',
                url: 'https://example.ts.net/__happier/transfer/machine-transfers/direct/imports/upload-https/chunks/2',
            },
            {
                method: 'POST',
                url: 'https://example.ts.net/__happier/transfer/machine-transfers/direct/imports/upload-https/finalize',
            },
        ]);
    });

    it('skips predecessor LAN HTTP import candidates and uploads through HTTPS', async () => {
        const requestedUrls: string[] = [];
        prepareImportSessionMock.mockResolvedValue({
            success: true,
            uploadId: 'upload-safe',
            destDisplayPath: '/repo/payload.bin',
            expectedSizeBytes: 5,
            chunkSizeBytes: 5,
            recipientPublicKeyBase64: Buffer.alloc(32, 7).toString('base64'),
            expiresAt: 5_000,
            endpointCandidates: [
                {
                    kind: 'http',
                    url: 'http://192.168.1.20:46001/machine-transfers/direct/imports/upload-safe',
                    expiresAt: 5_000,
                },
                {
                    kind: 'https',
                    url: 'https://machine.example.test/machine-transfers/direct/imports/upload-safe',
                    expiresAt: 5_000,
                },
            ],
        });
        setRuntimeFetch(async (input, init) => {
            const url = String(input);
            requestedUrls.push(url);
            if (url.endsWith('/chunks/0') && init?.method === 'PUT') {
                return new Response(JSON.stringify({ success: true }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            if (url.endsWith('/finalize') && init?.method === 'POST') {
                return new Response(JSON.stringify({
                    success: true,
                    finalized: { success: true, path: '/repo/payload.bin', sizeBytes: 5 },
                    sha256: 'sha256:test',
                }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            throw new Error(`unexpected request: ${String(init?.method)} ${url}`);
        });

        const result = await uploadBulkPayloadFromFileViaDirectImport({
            machineId: 'machine-1',
            fileReader: {
                sizeBytes: 5,
                readBytes: async () => new TextEncoder().encode('hello'),
                close: async () => {},
            },
            request: {
                t: 'session_file_upload_v1',
                workingDirectory: '/repo',
                path: '/repo/payload.bin',
                sizeBytes: 5,
                overwrite: true,
            },
        });

        expect(result).toMatchObject({ success: true });
        expect(requestedUrls).toEqual([
            'https://machine.example.test/machine-transfers/direct/imports/upload-safe/chunks/0',
            'https://machine.example.test/machine-transfers/direct/imports/upload-safe/finalize',
        ]);
        expect(prepareImportSessionMock).toHaveBeenCalledTimes(1);
    });

    it('can parse a non-file finalize response from direct import', async () => {
        prepareImportSessionMock.mockResolvedValue({
            success: true,
            uploadId: 'upload-1',
            destDisplayPath: 'prompt-asset-upload.json',
            expectedSizeBytes: 5,
            chunkSizeBytes: 5,
            recipientPublicKeyBase64: Buffer.alloc(32, 7).toString('base64'),
            expiresAt: 5_000,
            endpointCandidates: [
                {
                    kind: 'http',
                    url: 'http://127.0.0.1:46001/machine-transfers/direct/imports/upload-1',
                    expiresAt: 5_000,
                },
            ],
        });

        setRuntimeFetch(async (input, init) => {
            const url = input instanceof URL ? input.toString() : String(input);
            const method = String(init?.method ?? 'GET');

            if (url.includes('/chunks/') && method === 'PUT') {
                return new Response(JSON.stringify({ success: true }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }

            if (url.endsWith('/finalize') && method === 'POST') {
                return new Response(JSON.stringify({
                    success: true,
                    finalized: {
                        success: true,
                        path: 'prompt-asset-upload.json',
                        sizeBytes: 5,
                        result: {
                            ok: true,
                            externalRef: { skillName: 'writer' },
                            digest: 'digest-a',
                        },
                    },
                    sha256: 'sha256:test',
                }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }

            throw new Error(`unexpected request: ${method} ${url}`);
        });

        const result = await uploadBulkPayloadFromFileViaDirectImport({
            machineId: 'machine-1',
            serverId: 'server-1',
            fileReader: {
                sizeBytes: 5,
                readBytes: async (offset, length) => new TextEncoder().encode('hello').subarray(offset, offset + length),
                close: async () => {},
            },
            request: {
                t: 'prompt_asset_upload_v1',
                workingDirectory: '/repo',
                sizeBytes: 5,
            } as any,
            parseFinalizeResponse: (response) => {
                const result = response.finalized.result as Record<string, unknown> | undefined;
                if (!result || result.ok !== true) {
                    return null;
                }
                return {
                    ok: true,
                    externalRef: result.externalRef,
                    digest: result.digest,
                };
            },
        });

        expect(result).toEqual({
            ok: true,
            externalRef: { skillName: 'writer' },
            digest: 'digest-a',
        });
    });

    it('does not retry another endpoint after an application-level chunk rejection', async () => {
        const requests: Array<Readonly<{
            method: string;
            url: string;
            headers: Record<string, string>;
        }>> = [];
        const readRanges: Array<readonly [offset: number, length: number]> = [];
        const acceptedChunkIndexes: number[] = [];
        const encryptedChunkBodies = new Map<string, Readonly<{
            payloadBase64: string;
            encryptedDataKeyEnvelopeBase64: string;
        }>>();
        const recipientKeyPair = createTransferRecipientKeyPair({
            randomBytes: (length) => new Uint8Array(length).fill(7),
        });

        prepareImportSessionMock.mockResolvedValue({
            success: true,
            uploadId: 'upload-2',
            destDisplayPath: '/repo/payload.bin',
            expectedSizeBytes: 10,
            chunkSizeBytes: 5,
            recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
            expiresAt: 5_000,
            endpointCandidates: [
                {
                    kind: 'http',
                    url: 'http://127.0.0.1:46001/machine-transfers/direct/imports/upload-2',
                    expiresAt: 5_000,
                },
                {
                    kind: 'http',
                    url: 'http://127.0.0.1:46002/machine-transfers/direct/imports/upload-2',
                    expiresAt: 5_000,
                },
            ],
        });

        setRuntimeFetch(async (input, init) => {
            const url = input instanceof URL ? input.toString() : String(input);
            const method = String(init?.method ?? 'GET');
            requests.push({
                method,
                url,
                headers: readHeadersRecord(init?.headers),
            });

            if (url.startsWith('http://127.0.0.1:46001/') && url.endsWith('/chunks/0') && method === 'PUT') {
                encryptedChunkBodies.set(url, JSON.parse(String(init?.body)));
                acceptedChunkIndexes.push(0);
                return new Response(JSON.stringify({ success: true }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            if (url.startsWith('http://127.0.0.1:46001/') && url.endsWith('/chunks/1') && method === 'PUT') {
                encryptedChunkBodies.set(url, JSON.parse(String(init?.body)));
                return new Response(JSON.stringify({ success: false, error: 'first-candidate-failed' }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            if (url === 'http://127.0.0.1:46001/machine-transfers/direct/imports/upload-2/abort' && method === 'POST') {
                return Response.json({ success: true, aborted: true });
            }
            if (url.startsWith('http://127.0.0.1:46002/') && url.includes('/chunks/') && method === 'PUT') {
                encryptedChunkBodies.set(url, JSON.parse(String(init?.body)));
                acceptedChunkIndexes.push(Number(url.slice(url.lastIndexOf('/') + 1)));
                return new Response(JSON.stringify({ success: true }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            if (url.startsWith('http://127.0.0.1:46002/') && url.endsWith('/finalize') && method === 'POST') {
                return new Response(JSON.stringify({
                    success: true,
                    finalized: {
                        success: true,
                        path: '/repo/payload.bin',
                        sizeBytes: 10,
                    },
                    sha256: 'sha256:test',
                }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            throw new Error(`unexpected request: ${method} ${url}`);
        });

        const result = await uploadBulkPayloadFromFileViaDirectImport({
            machineId: 'machine-1',
            serverId: 'server-1',
            fileReader: {
                sizeBytes: 10,
                readBytes: async (offset, length) => {
                    readRanges.push([offset, length]);
                    return new TextEncoder().encode('helloworld').slice(offset, offset + length);
                },
                close: async () => {},
            },
            request: {
                t: 'session_file_upload_v1',
                workingDirectory: '/repo',
                path: '/repo/payload.bin',
                sizeBytes: 10,
                overwrite: true,
            },
        });

        expect(result).toMatchObject({ success: false, error: 'first-candidate-failed' });
        expect(requests.map((request) => request.url)).toEqual([
            'http://127.0.0.1:46001/machine-transfers/direct/imports/upload-2/chunks/0',
            'http://127.0.0.1:46001/machine-transfers/direct/imports/upload-2/chunks/1',
            'http://127.0.0.1:46001/machine-transfers/direct/imports/upload-2/abort',
        ]);
        expect(readRanges).toEqual([[0, 5], [5, 5]]);
        expect(acceptedChunkIndexes).toEqual([0]);
        expect(encryptedChunkBodies.has(
            'http://127.0.0.1:46002/machine-transfers/direct/imports/upload-2/chunks/1',
        )).toBe(false);
        expect(prepareImportSessionMock.mock.calls.map(([request]) => request.method)).toEqual(['daemon.filesystem.upload']);
    });

    it('retries a transient endpoint status through the shared direct-transfer classifier', async () => {
        const requests: string[] = [];
        const recipientKeyPair = createTransferRecipientKeyPair({
            randomBytes: (length) => new Uint8Array(length).fill(8),
        });
        prepareImportSessionMock.mockResolvedValue({
            success: true,
            uploadId: 'upload-transient',
            destDisplayPath: '/repo/payload.bin',
            expectedSizeBytes: 5,
            chunkSizeBytes: 5,
            recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
            expiresAt: 5_000,
            endpointCandidates: [
                {
                    kind: 'http',
                    url: 'http://127.0.0.1:46001/machine-transfers/direct/imports/upload-transient',
                    expiresAt: 5_000,
                },
                {
                    kind: 'http',
                    url: 'http://127.0.0.1:46002/machine-transfers/direct/imports/upload-transient',
                    expiresAt: 5_000,
                },
            ],
        });
        setRuntimeFetch(async (input, init) => {
            const url = input instanceof URL ? input.toString() : String(input);
            requests.push(url);
            if (url.startsWith('http://127.0.0.1:46001/')) {
                return new Response('temporarily unavailable', { status: 503 });
            }
            if (url.endsWith('/chunks/0')) {
                return new Response(JSON.stringify({ success: true }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            if (url.endsWith('/finalize')) {
                return new Response(JSON.stringify({
                    success: true,
                    finalized: { success: true, path: '/repo/payload.bin', sizeBytes: 5 },
                    sha256: 'sha256:test',
                }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            throw new Error(`unexpected request: ${String(init?.method ?? 'GET')} ${url}`);
        });

        const result = await uploadBulkPayloadFromFileViaDirectImport({
            machineId: 'machine-1',
            serverId: 'server-1',
            fileReader: {
                sizeBytes: 5,
                readBytes: async (offset, length) => new TextEncoder().encode('hello').slice(offset, offset + length),
                close: async () => {},
            },
            request: {
                t: 'session_file_upload_v1',
                workingDirectory: '/repo',
                path: '/repo/payload.bin',
                sizeBytes: 5,
                overwrite: true,
            },
        });

        expect(result).toMatchObject({ success: true, path: '/repo/payload.bin', sizeBytes: 5 });
        expect(requests).toEqual([
            'http://127.0.0.1:46001/machine-transfers/direct/imports/upload-transient/chunks/0',
            'http://127.0.0.1:46002/machine-transfers/direct/imports/upload-transient/chunks/0',
            'http://127.0.0.1:46002/machine-transfers/direct/imports/upload-transient/finalize',
        ]);
    });

    it('rejects invalid direct import endpoint candidates before issuing HTTP requests', async () => {
        prepareImportSessionMock.mockResolvedValue({
            success: true,
            uploadId: 'upload-3',
            destDisplayPath: '/repo/payload.bin',
            expectedSizeBytes: 5,
            chunkSizeBytes: 5,
            recipientPublicKeyBase64: Buffer.alloc(32, 7).toString('base64'),
            expiresAt: 5_000,
            endpointCandidates: [
                {
                    kind: 'http',
                    url: 'javascript:alert(1)',
                    expiresAt: 5_000,
                },
            ],
        });

        setRuntimeFetch(async () => {
            throw new Error('runtimeFetch should not be called for invalid candidates');
        });

        const result = await uploadBulkPayloadFromFileViaDirectImport({
            machineId: 'machine-1',
            serverId: 'server-1',
            fileReader: {
                sizeBytes: 5,
                readBytes: async () => new TextEncoder().encode('hello'),
                close: async () => {},
            },
            request: {
                t: 'session_file_upload_v1',
                workingDirectory: '/repo',
                path: '/repo/payload.bin',
                sizeBytes: 5,
                overwrite: true,
            },
        });

        expect(result).toEqual({
            success: false,
            error: 'Direct import prepare returned an unsupported response (shape: object; success=boolean; error=undefined; ok=undefined; result=undefined)',
            errorCode: 'DIRECT_IMPORT_PREPARE_INVALID',
        });
        // A malformed wire receipt does not prove ownership of its claimed ID.
        expect(prepareImportSessionMock).toHaveBeenCalledTimes(1);
    });

    it('reports a completed upload successful when the carrier release fails and hands custody back once', async () => {
        const release = vi.fn(async () => {
            throw new Error('native machine tunnel stop failed');
        });
        prepareImportSessionMock.mockResolvedValue({
            success: true,
            uploadId: 'upload-cleanup-failure',
            destDisplayPath: '/repo/payload.bin',
            expectedSizeBytes: 5,
            chunkSizeBytes: 5,
            recipientPublicKeyBase64: Buffer.alloc(32, 7).toString('base64'),
            expiresAt: 5_000,
            endpointCandidates: [{
                kind: 'http',
                url: 'http://127.0.0.1:46001/machine-transfers/direct/imports/upload-cleanup-failure',
                expiresAt: 5_000,
            }],
        });
        setRuntimeFetch(async (input, init) => {
            const url = String(input);
            if (url.endsWith('/chunks/0') && init?.method === 'PUT') {
                return new Response(JSON.stringify({ success: true }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            if (url.endsWith('/finalize') && init?.method === 'POST') {
                return new Response(JSON.stringify({
                    success: true,
                    finalized: { success: true, path: '/repo/payload.bin', sizeBytes: 5 },
                    sha256: 'sha256:test',
                }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            throw new Error(`unexpected request: ${String(init?.method)} ${url}`);
        });

        await expect(uploadBulkPayloadFromFileViaDirectImport({
            machineId: 'machine-1',
            serverId: 'server-1',
            fileReader: {
                sizeBytes: 5,
                readBytes: async () => new TextEncoder().encode('hello'),
                close: async () => {},
            },
            request: {
                t: 'session_file_upload_v1',
                workingDirectory: '/repo',
                path: '/repo/payload.bin',
                sizeBytes: 5,
                overwrite: true,
            },
            acquirePreparedCarrier: async () => ({
                kind: 'native_http' as const,
                localOrigin: 'http://127.0.0.1:48123',
                release,
            }),
        })).resolves.toEqual({
            success: true,
            path: '/repo/payload.bin',
            sizeBytes: 5,
            sha256: 'sha256:test',
        });
        // Custody goes back to the lease owner: this helper never retries the
        // release itself and never downgrades a completed transfer.
        expect(release).toHaveBeenCalledTimes(1);
    });

    it('aborts only the prepared HTTP capability after caller cancellation, without another Action', async () => {
        prepareImportSessionMock.mockResolvedValue({
            success: true,
            uploadId: 'upload-canceled',
            destDisplayPath: '/repo/payload.bin',
            expectedSizeBytes: 5,
            chunkSizeBytes: 5,
            recipientPublicKeyBase64: Buffer.alloc(32, 7).toString('base64'),
            expiresAt: 5_000,
            endpointCandidates: [{
                kind: 'http',
                url: 'http://127.0.0.1:46001/machine-transfers/direct/imports/upload-canceled',
                expiresAt: 5_000,
            }],
        });
        const controller = new AbortController();
        controller.abort(new Error('canceled'));
        const cleanupRequests: Array<{ url: string; signal?: AbortSignal | null }> = [];
        setRuntimeFetch(async (input, init) => {
            cleanupRequests.push({ url: String(input), signal: init?.signal });
            if (String(input) !== 'http://127.0.0.1:46001/machine-transfers/direct/imports/upload-canceled/abort') {
                throw new Error('Cancelled transfer must not write bytes');
            }
            return Response.json({ success: true, aborted: true });
        });

        await expect(uploadBulkPayloadFromFileViaDirectImport({
            machineId: 'machine-1',
            serverId: 'server-1',
            fileReader: {
                sizeBytes: 5,
                readBytes: async () => new TextEncoder().encode('hello'),
                close: async () => {},
            },
            request: {
                t: 'session_file_upload_v1',
                workingDirectory: '/repo',
                path: '/repo/payload.bin',
                sizeBytes: 5,
                overwrite: true,
            },
            timeoutMs: 23.9,
            signal: controller.signal,
        })).resolves.toEqual({ success: false, error: 'Upload canceled' });
        expect(prepareImportSessionMock.mock.calls.map(([request]) => request.method)).toEqual(['daemon.filesystem.upload']);
        expect(cleanupRequests).toHaveLength(1);
        expect(cleanupRequests[0]?.signal).not.toBe(controller.signal);
        expect(cleanupRequests[0]?.signal?.aborted ?? false).toBe(false);
    });

    it('passes the resolved deadline and caller signal to prepare so cancellation settles promptly', async () => {
        vi.useFakeTimers();
        try {
            let prepareStarted!: () => void;
            const started = new Promise<void>((resolve) => {
                prepareStarted = resolve;
            });
            prepareImportSessionMock.mockImplementationOnce(async (input: {
                timeoutMs?: number;
                signal?: AbortSignal;
            }) => await new Promise((resolve, reject) => {
                prepareStarted();
                if (input.signal?.aborted) {
                    reject(input.signal.reason);
                    return;
                }
                input.signal?.addEventListener('abort', () => {
                    reject(input.signal?.reason);
                }, { once: true });
                setTimeout(() => {
                    resolve({
                        success: false,
                        error: 'late prepare response',
                    });
                }, 100);
            }));

            const controller = new AbortController();
            let settled = false;
            const resultPromise = uploadBulkPayloadFromFileViaDirectImport({
                machineId: 'machine-1',
                serverId: 'server-1',
                fileReader: {
                    sizeBytes: 5,
                    readBytes: async () => new TextEncoder().encode('hello'),
                    close: async () => {},
                },
                request: {
                    t: 'session_file_upload_v1',
                    workingDirectory: '/repo',
                    path: '/repo/payload.bin',
                    sizeBytes: 5,
                    overwrite: true,
                },
                timeoutMs: 31.9,
                signal: controller.signal,
            });
            void resultPromise.then(
                () => {
                    settled = true;
                },
                () => {
                    settled = true;
                },
            );

            await started;
            const prepareCall = prepareImportSessionMock.mock.calls[0]?.[0] as {
                timeoutMs?: number;
                signal?: AbortSignal;
            } | undefined;
            controller.abort(new Error('caller canceled prepare'));
            await vi.advanceTimersByTimeAsync(0);
            const settledOnCancellation = settled;
            await vi.advanceTimersByTimeAsync(100);
            await resultPromise.catch(() => undefined);

            expect.soft(prepareCall?.timeoutMs).toBe(31);
            expect.soft(prepareCall?.signal).toBe(controller.signal);
            expect(settledOnCancellation).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
});
