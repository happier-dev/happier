import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const prepareImportSessionMock = vi.hoisted(() => vi.fn());

function readHeadersRecord(headers: HeadersInit | undefined): Record<string, string> {
    return Object.fromEntries(new Headers(headers).entries()) as Record<string, string>;
}

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc', () => ({
    callGuardedMachineRpcWithPolicy: (...args: unknown[]) => prepareImportSessionMock(...args),
}));

import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { uploadBulkPayloadFromFileViaDirectImport } from './directTransferImportUpload';
import {
    createTransferRecipientKeyPair,
    decryptEncryptedTransferChunkEnvelope,
} from './transferChunkEncryption';

describe('uploadBulkPayloadFromFileViaDirectImport', () => {
    afterEach(() => {
        prepareImportSessionMock.mockReset();
        resetRuntimeFetch();
    });

    it('prepares a direct import session and uploads encrypted chunks through the HTTP transfer endpoints', async () => {
        const requests: Array<Readonly<{
            method: string;
            url: string;
            headers: Record<string, string>;
        }>> = [];

        prepareImportSessionMock.mockResolvedValue({
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
        });

        setRuntimeFetch(async (input, init) => {
            const url = input instanceof URL ? input.toString() : String(input);
            const method = String(init?.method ?? 'GET');
            requests.push({
                method,
                url,
                headers: readHeadersRecord(init?.headers),
            });

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
        expect(prepareImportSessionMock).toHaveBeenCalledTimes(1);
        expect(prepareImportSessionMock).toHaveBeenCalledWith(expect.objectContaining({
            method: RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_PREPARE,
        }));
        expect(requests).toEqual([
            {
                method: 'PUT',
                url: 'http://127.0.0.1:46001/machine-transfers/direct/imports/upload-1/chunks/0',
                headers: { 'content-type': 'application/json' },
            },
            {
                method: 'PUT',
                url: 'http://127.0.0.1:46001/machine-transfers/direct/imports/upload-1/chunks/1',
                headers: { 'content-type': 'application/json' },
            },
            {
                method: 'PUT',
                url: 'http://127.0.0.1:46001/machine-transfers/direct/imports/upload-1/chunks/2',
                headers: { 'content-type': 'application/json' },
            },
            {
                method: 'POST',
                url: 'http://127.0.0.1:46001/machine-transfers/direct/imports/upload-1/finalize',
                headers: {},
            },
        ]);
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

    it('continues a partially written shared import session through the next endpoint candidate', async () => {
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

        expect(result).toEqual({
            success: true,
            path: '/repo/payload.bin',
            sizeBytes: 10,
            sha256: 'sha256:test',
        });
        expect(requests).toEqual(expect.arrayContaining([
            {
                method: 'PUT',
                url: 'http://127.0.0.1:46001/machine-transfers/direct/imports/upload-2/chunks/0',
                headers: { 'content-type': 'application/json' },
            },
            {
                method: 'PUT',
                url: 'http://127.0.0.1:46001/machine-transfers/direct/imports/upload-2/chunks/1',
                headers: { 'content-type': 'application/json' },
            },
            {
                method: 'PUT',
                url: 'http://127.0.0.1:46002/machine-transfers/direct/imports/upload-2/chunks/1',
                headers: { 'content-type': 'application/json' },
            },
            {
                method: 'POST',
                url: 'http://127.0.0.1:46002/machine-transfers/direct/imports/upload-2/finalize',
                headers: {},
            },
        ]));
        expect(requests).not.toContainEqual({
            method: 'PUT',
            url: 'http://127.0.0.1:46002/machine-transfers/direct/imports/upload-2/chunks/0',
            headers: { 'content-type': 'application/json' },
        });
        expect(readRanges).toEqual([[0, 5], [5, 5], [5, 5]]);
        expect(acceptedChunkIndexes).toEqual([0, 1]);
        const resumedEnvelope = encryptedChunkBodies.get(
            'http://127.0.0.1:46002/machine-transfers/direct/imports/upload-2/chunks/1',
        );
        expect(resumedEnvelope).toBeDefined();
        await expect(decryptEncryptedTransferChunkEnvelope({
            transferId: 'upload-2',
            sequence: 1,
            payloadBase64: resumedEnvelope!.payloadBase64,
            encryptedDataKeyEnvelopeBase64: resumedEnvelope!.encryptedDataKeyEnvelopeBase64,
            recipientSecretKeySeed: recipientKeyPair.recipientSecretKeySeed,
        })).resolves.toEqual(new TextEncoder().encode('world'));
        expect(prepareImportSessionMock).toHaveBeenCalledTimes(1);
        expect(prepareImportSessionMock).not.toHaveBeenCalledWith(expect.objectContaining({
            method: RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_ABORT,
        }));
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
            error: 'Direct import prepare returned invalid endpoint metadata',
            errorCode: 'DIRECT_IMPORT_PREPARE_INVALID',
        });
        expect(prepareImportSessionMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            method: RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_ABORT,
            payload: { uploadId: 'upload-3' },
        }));
    });

    it('aborts a prepared direct import through machine RPC exactly once after caller cancellation', async () => {
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
        setRuntimeFetch(async () => {
            throw new Error('HTTP transfer route must not run after cancellation');
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
        expect(prepareImportSessionMock).toHaveBeenCalledTimes(2);
        expect(prepareImportSessionMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            method: RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_ABORT,
            payload: { uploadId: 'upload-canceled' },
            timeoutMs: 23,
        }));
        const cleanupCall = prepareImportSessionMock.mock.calls[1]?.[0] as { signal?: AbortSignal } | undefined;
        expect(cleanupCall?.signal).not.toBe(controller.signal);
        expect(cleanupCall?.signal?.aborted ?? false).toBe(false);
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
