import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

import { uploadBulkPayloadFromFileWithCarrierFallbacks } from './uploadBulkPayloadFromFileWithCarrierFallbacks';

const prepareDirectImportMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc', () => ({
    callGuardedMachineRpcWithPolicy: (...args: unknown[]) => prepareDirectImportMock(...args),
}));

type UploadResult =
    | Readonly<{ success: true; path: string; sizeBytes: number; sha256: string }>
    | Readonly<{ success: false; error: string }>;

function createReader(close: () => Promise<void>) {
    const payload = new TextEncoder().encode('hello');
    return {
        sizeBytes: payload.byteLength,
        readBytes: async (offset: number, length: number) => payload.subarray(offset, offset + length),
        close,
    };
}

function createRelay() {
    return {
        init: vi.fn(async () => ({
            success: true as const,
            uploadId: 'relay-upload-1',
            chunkSizeBytes: 2,
            recipientPublicKeyBase64: Buffer.alloc(32, 7).toString('base64'),
        })),
        sendChunk: vi.fn(async () => ({ success: true as const })),
        finalize: vi.fn(async (): Promise<UploadResult> => ({
            success: true,
            path: '/repo/hello.txt',
            sizeBytes: 5,
            sha256: 'sha256:relay',
        })),
        abort: vi.fn(async () => ({ success: true as const })),
    };
}

describe('uploadBulkPayloadFromFileWithCarrierFallbacks', () => {
    afterEach(() => {
        prepareDirectImportMock.mockReset();
        resetRuntimeFetch();
    });

    it('falls back to the relay uploader when direct import is disabled', async () => {
        prepareDirectImportMock.mockResolvedValueOnce({
            success: false,
            error: 'Direct import endpoints unavailable',
        });
        const close = vi.fn(async () => {});
        const relay = createRelay();

        const result = await uploadBulkPayloadFromFileWithCarrierFallbacks<UploadResult>({
            machineId: 'machine-1',
            serverId: 'server-1',
            fileReader: createReader(close),
            directImportRequest: {
                t: 'session_file_upload_v1',
                workingDirectory: '/repo',
                path: '/repo/hello.txt',
                sizeBytes: 5,
                overwrite: true,
            },
            relay,
        });

        expect(result).toEqual({
            success: true,
            path: '/repo/hello.txt',
            sizeBytes: 5,
            sha256: 'sha256:relay',
        });
        expect(relay.init).toHaveBeenCalledTimes(1);
        expect(relay.sendChunk).toHaveBeenCalledTimes(3);
        expect(relay.finalize).toHaveBeenCalledTimes(1);
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('rejects a predecessor LAN HTTP candidate, aborts its allocation, then falls back to relay', async () => {
        prepareDirectImportMock
            .mockResolvedValueOnce({
                success: true,
                uploadId: 'direct-upload-1',
                destDisplayPath: '/repo/hello.txt',
                expectedSizeBytes: 5,
                chunkSizeBytes: 5,
                recipientPublicKeyBase64: Buffer.alloc(32, 9).toString('base64'),
                expiresAt: 5_000,
                endpointCandidates: [{
                    kind: 'http',
                    url: 'http://192.168.1.20:46001/machine-transfers/direct/imports/direct-upload-1',
                    expiresAt: 5_000,
                }],
            })
            .mockResolvedValueOnce({ success: true });
        setRuntimeFetch(async () => {
            throw new Error('LAN endpoint unreachable');
        });
        const close = vi.fn(async () => {});
        const relay = createRelay();

        const result = await uploadBulkPayloadFromFileWithCarrierFallbacks<UploadResult>({
            machineId: 'machine-1',
            serverId: 'server-1',
            fileReader: createReader(close),
            directImportRequest: {
                t: 'session_attachment_upload_v1',
                workingDirectory: '/repo',
                messageLocalId: 'message-1',
                fileName: 'hello.txt',
                sizeBytes: 5,
            },
            relay,
        });

        expect(result.success).toBe(true);
        expect(prepareDirectImportMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            method: RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_ABORT,
            payload: { uploadId: 'direct-upload-1' },
        }));
        expect(prepareDirectImportMock.mock.invocationCallOrder[1]).toBeLessThan(
            relay.init.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
        );
        expect(relay.init).toHaveBeenCalledTimes(1);
        expect(relay.finalize).toHaveBeenCalledTimes(1);
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('aborts malformed prepared candidates exactly once before falling back to relay', async () => {
        prepareDirectImportMock
            .mockResolvedValueOnce({
                success: true,
                uploadId: 'direct-upload-null',
                destDisplayPath: '/repo/hello.txt',
                expectedSizeBytes: 5,
                chunkSizeBytes: 5,
                recipientPublicKeyBase64: Buffer.alloc(32, 9).toString('base64'),
                expiresAt: 5_000,
                endpointCandidates: [null],
            })
            .mockResolvedValueOnce({ success: true });
        const relay = createRelay();
        const close = vi.fn(async () => {});

        const result = await uploadBulkPayloadFromFileWithCarrierFallbacks<UploadResult>({
            machineId: 'machine-1',
            fileReader: createReader(close),
            directImportRequest: {
                t: 'session_file_upload_v1',
                workingDirectory: '/repo',
                path: '/repo/hello.txt',
                sizeBytes: 5,
                overwrite: true,
            },
            relay,
        });

        expect(result.success).toBe(true);
        expect(prepareDirectImportMock).toHaveBeenCalledTimes(2);
        expect(prepareDirectImportMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            method: RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_ABORT,
            payload: { uploadId: 'direct-upload-null' },
        }));
        expect(prepareDirectImportMock.mock.invocationCallOrder[1]).toBeLessThan(
            relay.init.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
        );
        expect(relay.init).toHaveBeenCalledTimes(1);
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('does not start relay when authenticated direct-import cleanup fails', async () => {
        prepareDirectImportMock
            .mockResolvedValueOnce({
                success: true,
                uploadId: 'direct-upload-cleanup-fails',
                destDisplayPath: '/repo/hello.txt',
                expectedSizeBytes: 5,
                chunkSizeBytes: 5,
                recipientPublicKeyBase64: Buffer.alloc(32, 9).toString('base64'),
                expiresAt: 5_000,
                endpointCandidates: [{
                    kind: 'https',
                    url: 'https://machine.example.test/machine-transfers/direct/imports/direct-upload-cleanup-fails',
                    expiresAt: 5_000,
                }],
            })
            .mockResolvedValueOnce({ success: false, error: 'abort rejected' });
        setRuntimeFetch(async () => {
            throw new Error('direct endpoint unreachable');
        });
        const relay = createRelay();
        const close = vi.fn(async () => {});

        const result = await uploadBulkPayloadFromFileWithCarrierFallbacks<UploadResult>({
            machineId: 'machine-1',
            fileReader: createReader(close),
            directImportRequest: {
                t: 'session_attachment_upload_v1',
                workingDirectory: '/repo',
                messageLocalId: 'message-1',
                fileName: 'hello.txt',
                sizeBytes: 5,
            },
            relay,
            timeoutMs: 29.9,
        });

        expect(result).toEqual({
            success: false,
            error: 'Direct import cleanup failed: abort rejected',
            errorCode: 'DIRECT_IMPORT_CLEANUP_FAILED',
        });
        expect(prepareDirectImportMock).toHaveBeenCalledTimes(2);
        expect(prepareDirectImportMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            method: RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_ABORT,
            payload: { uploadId: 'direct-upload-cleanup-fails' },
            timeoutMs: 29,
        }));
        expect(relay.init).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('aborts an unreachable HTTPS import before starting relay', async () => {
        prepareDirectImportMock
            .mockResolvedValueOnce({
                success: true,
                uploadId: 'direct-upload-unreachable',
                destDisplayPath: '/repo/hello.txt',
                expectedSizeBytes: 5,
                chunkSizeBytes: 5,
                recipientPublicKeyBase64: Buffer.alloc(32, 9).toString('base64'),
                expiresAt: 5_000,
                endpointCandidates: [{
                    kind: 'https',
                    url: 'https://machine.example.test/machine-transfers/direct/imports/direct-upload-unreachable',
                    expiresAt: 5_000,
                }],
            })
            .mockResolvedValueOnce({ success: true });
        setRuntimeFetch(async () => {
            throw new Error('direct endpoint unreachable');
        });
        const relay = createRelay();

        const result = await uploadBulkPayloadFromFileWithCarrierFallbacks<UploadResult>({
            machineId: 'machine-1',
            fileReader: createReader(async () => {}),
            directImportRequest: {
                t: 'session_file_upload_v1',
                workingDirectory: '/repo',
                path: '/repo/hello.txt',
                sizeBytes: 5,
                overwrite: true,
            },
            relay,
        });

        expect(result.success).toBe(true);
        expect(prepareDirectImportMock.mock.invocationCallOrder[1]).toBeLessThan(
            relay.init.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
        );
        expect(relay.init).toHaveBeenCalledTimes(1);
    });

    it('bounds streamed direct-import chunk responses before authenticated cleanup and relay fallback', async () => {
        prepareDirectImportMock
            .mockResolvedValueOnce({
                success: true,
                uploadId: 'direct-upload-oversized-response',
                destDisplayPath: '/repo/hello.txt',
                expectedSizeBytes: 5,
                chunkSizeBytes: 5,
                recipientPublicKeyBase64: Buffer.alloc(32, 9).toString('base64'),
                expiresAt: 5_000,
                endpointCandidates: [{
                    kind: 'https',
                    url: 'https://machine.example.test/machine-transfers/direct/imports/direct-upload-oversized-response',
                    expiresAt: 5_000,
                }],
            })
            .mockResolvedValueOnce({ success: true });
        const oversizedJson = new TextEncoder().encode(JSON.stringify({
            success: true,
            padding: 'x'.repeat(8 * 1024),
        }));
        const oversizedChunkResponse = new Response(new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(oversizedJson.subarray(0, 4 * 1024));
                controller.enqueue(oversizedJson.subarray(4 * 1024));
                controller.close();
            },
        }), {
            status: 200,
            headers: { 'content-type': 'application/json; charset=utf-8' },
        });
        expect(oversizedChunkResponse.headers.has('content-length')).toBe(false);

        setRuntimeFetch(async (input, init) => {
            const url = String(input);
            if (url.endsWith('/chunks/0') && init?.method === 'PUT') {
                return oversizedChunkResponse;
            }
            if (url.endsWith('/finalize') && init?.method === 'POST') {
                return new Response(JSON.stringify({
                    success: true,
                    finalized: {
                        success: true,
                        path: '/repo/hello.txt',
                        sizeBytes: 5,
                    },
                    sha256: 'sha256:direct',
                }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            throw new Error(`unexpected request: ${String(init?.method)} ${url}`);
        });
        const relay = createRelay();

        const result = await uploadBulkPayloadFromFileWithCarrierFallbacks<UploadResult>({
            machineId: 'machine-1',
            serverId: 'server-1',
            fileReader: createReader(async () => {}),
            directImportRequest: {
                t: 'session_file_upload_v1',
                workingDirectory: '/repo',
                path: '/repo/hello.txt',
                sizeBytes: 5,
                overwrite: true,
            },
            relay,
        });

        expect(result).toEqual({
            success: true,
            path: '/repo/hello.txt',
            sizeBytes: 5,
            sha256: 'sha256:relay',
        });
        expect(prepareDirectImportMock).toHaveBeenCalledTimes(2);
        expect(prepareDirectImportMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            method: RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_ABORT,
            payload: { uploadId: 'direct-upload-oversized-response' },
        }));
        expect(prepareDirectImportMock.mock.invocationCallOrder[1]).toBeLessThan(
            relay.init.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
        );
        expect(relay.init).toHaveBeenCalledTimes(1);
        expect(relay.finalize).toHaveBeenCalledTimes(1);
    });

    it('cancels a stalled under-limit direct-import response before authenticated cleanup without starting relay', async () => {
        vi.useFakeTimers();
        try {
            prepareDirectImportMock
                .mockResolvedValueOnce({
                    success: true,
                    uploadId: 'direct-upload-caller-canceled',
                    destDisplayPath: '/repo/hello.txt',
                    expectedSizeBytes: 5,
                    chunkSizeBytes: 5,
                    recipientPublicKeyBase64: Buffer.alloc(32, 9).toString('base64'),
                    expiresAt: 5_000,
                    endpointCandidates: [{
                        kind: 'https',
                        url: 'https://machine.example.test/machine-transfers/direct/imports/direct-upload-caller-canceled',
                        expiresAt: 5_000,
                    }],
                })
                .mockResolvedValueOnce({ success: true });

            let bodyCanceled = false;
            let markRequestStarted!: () => void;
            const requestStarted = new Promise<void>((resolve) => {
                markRequestStarted = resolve;
            });
            setRuntimeFetch(async (input, init) => {
                const url = String(input);
                if (url.endsWith('/chunks/0') && init?.method === 'PUT') {
                    markRequestStarted();
                    return new Response(new ReadableStream<Uint8Array>({
                        start(controller) {
                            controller.enqueue(new TextEncoder().encode('{"success":'));
                            setTimeout(() => {
                                if (!bodyCanceled) {
                                    controller.close();
                                }
                            }, 100);
                        },
                        cancel() {
                            bodyCanceled = true;
                        },
                    }), {
                        status: 200,
                        headers: { 'content-type': 'application/json' },
                    });
                }
                throw new Error(`unexpected request: ${String(init?.method)} ${url}`);
            });

            const close = vi.fn(async () => {});
            const relay = createRelay();
            const controller = new AbortController();
            let settled = false;
            const resultPromise = uploadBulkPayloadFromFileWithCarrierFallbacks<UploadResult>({
                machineId: 'machine-1',
                serverId: 'server-1',
                fileReader: createReader(close),
                directImportRequest: {
                    t: 'session_file_upload_v1',
                    workingDirectory: '/repo',
                    path: '/repo/hello.txt',
                    sizeBytes: 5,
                    overwrite: true,
                },
                relay,
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

            await requestStarted;
            controller.abort(new Error('caller canceled'));
            await vi.advanceTimersByTimeAsync(0);
            const settledOnCancellation = settled;
            await vi.advanceTimersByTimeAsync(100);
            const result = await resultPromise;

            expect(result).toMatchObject({ success: false });
            expect(settledOnCancellation).toBe(true);
            expect(bodyCanceled).toBe(true);
            expect(prepareDirectImportMock).toHaveBeenCalledTimes(2);
            expect(prepareDirectImportMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
                method: RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_ABORT,
                payload: { uploadId: 'direct-upload-caller-canceled' },
            }));
            expect(relay.init).not.toHaveBeenCalled();
            expect(relay.sendChunk).not.toHaveBeenCalled();
            expect(relay.finalize).not.toHaveBeenCalled();
            expect(close).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps the direct-import request deadline active through a stalled under-limit body before aborting and relaying', async () => {
        vi.useFakeTimers();
        try {
            prepareDirectImportMock
                .mockResolvedValueOnce({
                    success: true,
                    uploadId: 'direct-upload-body-timeout',
                    destDisplayPath: '/repo/hello.txt',
                    expectedSizeBytes: 5,
                    chunkSizeBytes: 5,
                    recipientPublicKeyBase64: Buffer.alloc(32, 9).toString('base64'),
                    expiresAt: 5_000,
                    endpointCandidates: [{
                        kind: 'https',
                        url: 'https://machine.example.test/machine-transfers/direct/imports/direct-upload-body-timeout',
                        expiresAt: 5_000,
                    }],
                })
                .mockResolvedValueOnce({ success: true });

            let bodyAborted = false;
            let markRequestStarted!: () => void;
            const requestStarted = new Promise<void>((resolve) => {
                markRequestStarted = resolve;
            });
            setRuntimeFetch(async (input, init) => {
                const url = String(input);
                if (url.endsWith('/chunks/0') && init?.method === 'PUT') {
                    markRequestStarted();
                    return new Response(new ReadableStream<Uint8Array>({
                        start(controller) {
                            controller.enqueue(new TextEncoder().encode('{"success":'));
                            init?.signal?.addEventListener('abort', () => {
                                bodyAborted = true;
                                controller.error(new DOMException('The operation was aborted', 'AbortError'));
                            }, { once: true });
                            setTimeout(() => {
                                if (!bodyAborted) {
                                    controller.close();
                                }
                            }, 100);
                        },
                    }), {
                        status: 200,
                        headers: { 'content-type': 'application/json' },
                    });
                }
                throw new Error(`unexpected request: ${String(init?.method)} ${url}`);
            });

            const relay = createRelay();
            const close = vi.fn(async () => {});
            const uploadInput = {
                machineId: 'machine-1',
                serverId: 'server-1',
                fileReader: createReader(close),
                directImportRequest: {
                    t: 'session_file_upload_v1' as const,
                    workingDirectory: '/repo',
                    path: '/repo/hello.txt',
                    sizeBytes: 5,
                    overwrite: true,
                },
                relay,
                timeoutMs: 10,
            };
            const resultPromise = uploadBulkPayloadFromFileWithCarrierFallbacks<UploadResult>(uploadInput);

            await requestStarted;
            await vi.advanceTimersByTimeAsync(10);
            const bodyAbortedAtDeadline = bodyAborted;
            await vi.advanceTimersByTimeAsync(90);
            const result = await resultPromise;

            expect(bodyAbortedAtDeadline).toBe(true);
            expect(result).toEqual({
                success: true,
                path: '/repo/hello.txt',
                sizeBytes: 5,
                sha256: 'sha256:relay',
            });
            expect(prepareDirectImportMock).toHaveBeenCalledTimes(2);
            expect(prepareDirectImportMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
                method: RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_ABORT,
                payload: { uploadId: 'direct-upload-body-timeout' },
            }));
            expect(prepareDirectImportMock.mock.invocationCallOrder[1]).toBeLessThan(
                relay.init.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
            );
            expect(relay.init).toHaveBeenCalledTimes(1);
            expect(relay.finalize).toHaveBeenCalledTimes(1);
            expect(close).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it.each([
        {
            caseName: 'malformed finalize success envelope',
            finalizeBody: {
                success: true,
            },
            parseDirectFinalizeResponse: null,
        },
        {
            caseName: 'consumer-rejected committed finalize result',
            finalizeBody: {
                success: true,
                finalized: {
                    success: true,
                    path: 'prompt-asset-upload.json',
                    sizeBytes: 5,
                    result: { ok: true, externalRef: null },
                },
                sha256: 'sha256:direct',
            },
            parseDirectFinalizeResponse: () => null,
        },
    ])('does not repeat a committed direct mutation through relay for $caseName', async ({
        finalizeBody,
        parseDirectFinalizeResponse,
    }) => {
        prepareDirectImportMock.mockResolvedValueOnce({
            success: true,
            uploadId: 'direct-upload-committed-result-unusable',
            destDisplayPath: 'prompt-asset-upload.json',
            expectedSizeBytes: 5,
            chunkSizeBytes: 5,
            recipientPublicKeyBase64: Buffer.alloc(32, 9).toString('base64'),
            expiresAt: 5_000,
            endpointCandidates: [{
                kind: 'https',
                url: 'https://machine.example.test/machine-transfers/direct/imports/direct-upload-committed-result-unusable',
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
                return new Response(JSON.stringify(finalizeBody), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            throw new Error(`unexpected request: ${String(init?.method)} ${url}`);
        });
        const close = vi.fn(async () => {});
        const relay = createRelay();

        const result = await uploadBulkPayloadFromFileWithCarrierFallbacks<UploadResult>({
            machineId: 'machine-1',
            serverId: 'server-1',
            fileReader: createReader(close),
            directImportRequest: {
                t: 'prompt_asset_upload_v1',
                workingDirectory: '/',
                sizeBytes: 5,
            },
            parseDirectFinalizeResponse,
            relay,
        });

        expect(result).toMatchObject({
            success: false,
            errorCode: 'DIRECT_IMPORT_REMOTE_COMMITTED_RESULT_UNUSABLE',
        });
        expect(prepareDirectImportMock).toHaveBeenCalledTimes(1);
        expect(relay.init).not.toHaveBeenCalled();
        expect(relay.sendChunk).not.toHaveBeenCalled();
        expect(relay.finalize).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('does not repeat a mutation when an issued finalize commits but its response is lost', async () => {
        vi.useFakeTimers();
        try {
            prepareDirectImportMock
                .mockResolvedValueOnce({
                    success: true,
                    uploadId: 'direct-upload-finalize-response-lost',
                    destDisplayPath: '/repo/hello.txt',
                    expectedSizeBytes: 5,
                    chunkSizeBytes: 5,
                    recipientPublicKeyBase64: Buffer.alloc(32, 9).toString('base64'),
                    expiresAt: 5_000,
                    endpointCandidates: [{
                        kind: 'https',
                        url: 'https://machine.example.test/machine-transfers/direct/imports/direct-upload-finalize-response-lost',
                        expiresAt: 5_000,
                    }],
                })
                .mockResolvedValueOnce({ success: true });

            let daemonCommitCompleted = false;
            let finalizeIssued!: () => void;
            const issued = new Promise<void>((resolve) => {
                finalizeIssued = resolve;
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
                    daemonCommitCompleted = true;
                    finalizeIssued();
                    return await new Promise<Response>((_resolve, reject) => {
                        init.signal?.addEventListener('abort', () => {
                            reject(init.signal?.reason);
                        }, { once: true });
                    });
                }
                throw new Error(`unexpected request: ${String(init?.method)} ${url}`);
            });

            const relay = createRelay();
            const close = vi.fn(async () => {});
            const resultPromise = uploadBulkPayloadFromFileWithCarrierFallbacks<UploadResult>({
                machineId: 'machine-1',
                serverId: 'server-1',
                fileReader: createReader(close),
                directImportRequest: {
                    t: 'session_file_upload_v1',
                    workingDirectory: '/repo',
                    path: '/repo/hello.txt',
                    sizeBytes: 5,
                    overwrite: true,
                },
                relay,
                timeoutMs: 11,
            });

            await issued;
            await vi.advanceTimersByTimeAsync(11);
            const result = await resultPromise;

            expect(daemonCommitCompleted).toBe(true);
            expect(result).toMatchObject({
                success: false,
                errorCode: 'DIRECT_IMPORT_FINALIZE_OUTCOME_INDETERMINATE',
            });
            expect(prepareDirectImportMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
                method: RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_ABORT,
                payload: { uploadId: 'direct-upload-finalize-response-lost' },
            }));
            expect(relay.init).not.toHaveBeenCalled();
            expect(relay.sendChunk).not.toHaveBeenCalled();
            expect(relay.finalize).not.toHaveBeenCalled();
            expect(close).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it.each([400, 404, 409])(
        'allows relay fallback after an observed pre-commit finalize response with status %i',
        async (status) => {
            prepareDirectImportMock
                .mockResolvedValueOnce({
                    success: true,
                    uploadId: `direct-upload-finalize-${status}`,
                    destDisplayPath: '/repo/hello.txt',
                    expectedSizeBytes: 5,
                    chunkSizeBytes: 5,
                    recipientPublicKeyBase64: Buffer.alloc(32, 9).toString('base64'),
                    expiresAt: 5_000,
                    endpointCandidates: [{
                        kind: 'https',
                        url: `https://machine.example.test/machine-transfers/direct/imports/direct-upload-finalize-${status}`,
                        expiresAt: 5_000,
                    }],
                })
                .mockResolvedValueOnce({ success: true });
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
                        error: 'finalize rejected before commit',
                    }), {
                        status,
                        headers: { 'content-type': 'application/json' },
                    });
                }
                throw new Error(`unexpected request: ${String(init?.method)} ${url}`);
            });

            const relay = createRelay();
            const result = await uploadBulkPayloadFromFileWithCarrierFallbacks<UploadResult>({
                machineId: 'machine-1',
                serverId: 'server-1',
                fileReader: createReader(async () => {}),
                directImportRequest: {
                    t: 'session_file_upload_v1',
                    workingDirectory: '/repo',
                    path: '/repo/hello.txt',
                    sizeBytes: 5,
                    overwrite: true,
                },
                relay,
            });

            expect(result).toMatchObject({
                success: true,
                sha256: 'sha256:relay',
            });
            expect(prepareDirectImportMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
                method: RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_ABORT,
                payload: { uploadId: `direct-upload-finalize-${status}` },
            }));
            expect(relay.init).toHaveBeenCalledTimes(1);
            expect(relay.finalize).toHaveBeenCalledTimes(1);
        },
    );

    it('preserves the retained direct session and blocks candidate and relay fallback when finalize requires recovery', async () => {
        const expiresAt = Date.now() + 60_000;
        prepareDirectImportMock.mockResolvedValueOnce({
            success: true,
            uploadId: 'direct-upload-finalize-recovery-required',
            destDisplayPath: '/repo/hello.txt',
            expectedSizeBytes: 5,
            chunkSizeBytes: 5,
            recipientPublicKeyBase64: Buffer.alloc(32, 9).toString('base64'),
            expiresAt,
            endpointCandidates: [
                {
                    kind: 'https',
                    url: 'https://machine-a.example.test/machine-transfers/direct/imports/direct-upload-finalize-recovery-required',
                    expiresAt,
                },
                {
                    kind: 'https',
                    url: 'https://machine-b.example.test/machine-transfers/direct/imports/direct-upload-finalize-recovery-required',
                    expiresAt,
                },
            ],
        });
        const requestedUrls: string[] = [];
        let finalizeAttempts = 0;
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
                finalizeAttempts += 1;
                if (finalizeAttempts === 2) {
                    return new Response(JSON.stringify({
                        success: true,
                        finalized: {
                            success: true,
                            path: '/repo/hello.txt',
                            sizeBytes: 5,
                        },
                        sha256: 'sha256:direct-recovered',
                    }), {
                        status: 200,
                        headers: { 'content-type': 'application/json' },
                    });
                }
                return new Response(JSON.stringify({
                    success: false,
                    error: 'Finalize recovery is required',
                    errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED',
                    keepSession: true,
                }), {
                    status: 500,
                    headers: { 'content-type': 'application/json' },
                });
            }
            throw new Error(`unexpected request: ${String(init?.method)} ${url}`);
        });

        const relay = createRelay();
        const result = await uploadBulkPayloadFromFileWithCarrierFallbacks<UploadResult>({
            machineId: 'machine-1',
            serverId: 'server-1',
            fileReader: createReader(async () => {}),
            directImportRequest: {
                t: 'session_file_upload_v1',
                workingDirectory: '/repo',
                path: '/repo/hello.txt',
                sizeBytes: 5,
                overwrite: true,
            },
            relay,
        });

        expect(result).toMatchObject({
            success: false,
            error: 'Finalize recovery is required',
            errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED',
            recovery: {
                kind: 'transfer_finalize_recovery',
                expiresAt,
                actions: ['retry_finalize', 'discard_staged'],
            },
        });
        if (!result.success && 'recovery' in result) {
            expect(Object.isFrozen(result.recovery.actions)).toBe(true);
        }
        if (result.success || !('recovery' in result) || !result.recovery) {
            throw new Error('expected finalize recovery continuation');
        }

        await expect(Promise.all([
            result.recovery.invoke('retry_finalize'),
            result.recovery.invoke('retry_finalize'),
        ])).resolves.toEqual([
            {
                status: 'finalized',
                response: {
                    success: true,
                    path: '/repo/hello.txt',
                    sizeBytes: 5,
                    sha256: 'sha256:direct-recovered',
                },
            },
            {
                status: 'finalized',
                response: {
                    success: true,
                    path: '/repo/hello.txt',
                    sizeBytes: 5,
                    sha256: 'sha256:direct-recovered',
                },
            },
        ]);
        expect(prepareDirectImportMock).toHaveBeenCalledTimes(1);
        expect(requestedUrls).toEqual([
            'https://machine-a.example.test/machine-transfers/direct/imports/direct-upload-finalize-recovery-required/chunks/0',
            'https://machine-a.example.test/machine-transfers/direct/imports/direct-upload-finalize-recovery-required/finalize',
            'https://machine-a.example.test/machine-transfers/direct/imports/direct-upload-finalize-recovery-required/finalize',
        ]);
        expect(relay.init).not.toHaveBeenCalled();
        expect(relay.sendChunk).not.toHaveBeenCalled();
        expect(relay.finalize).not.toHaveBeenCalled();
    });

    it('discards the exact retained direct session once without finalizing or falling back', async () => {
        const expiresAt = Date.now() + 60_000;
        prepareDirectImportMock
            .mockResolvedValueOnce({
                success: true,
                uploadId: 'direct-upload-discard-recovery',
                destDisplayPath: '/repo/hello.txt',
                expectedSizeBytes: 5,
                chunkSizeBytes: 5,
                recipientPublicKeyBase64: Buffer.alloc(32, 9).toString('base64'),
                expiresAt,
                endpointCandidates: [{
                    kind: 'https',
                    url: 'https://machine.example.test/machine-transfers/direct/imports/direct-upload-discard-recovery',
                    expiresAt,
                }],
            })
            .mockResolvedValueOnce({ success: true, aborted: true });
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
                    headers: { 'content-type': 'application/json' },
                });
            }
            throw new Error(`unexpected request: ${String(init?.method)} ${url}`);
        });

        const relay = createRelay();
        const result = await uploadBulkPayloadFromFileWithCarrierFallbacks<UploadResult>({
            machineId: 'machine-1',
            serverId: 'server-1',
            fileReader: createReader(async () => {}),
            directImportRequest: {
                t: 'session_file_upload_v1',
                workingDirectory: '/repo',
                path: '/repo/hello.txt',
                sizeBytes: 5,
                overwrite: true,
            },
            relay,
        });
        if (result.success || !('recovery' in result) || !result.recovery) {
            throw new Error('expected finalize recovery continuation');
        }

        await expect(Promise.all([
            result.recovery.invoke('discard_staged'),
            result.recovery.invoke('discard_staged'),
        ])).resolves.toEqual([
            { status: 'discarded' },
            { status: 'discarded' },
        ]);
        expect(prepareDirectImportMock).toHaveBeenCalledTimes(2);
        expect(prepareDirectImportMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            method: RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_ABORT,
            payload: { uploadId: 'direct-upload-discard-recovery' },
        }));
        expect(relay.init).not.toHaveBeenCalled();
        expect(relay.finalize).not.toHaveBeenCalled();
    });

    it('lets the daemon settle an expired continuation and does not repeat recovery work', async () => {
        prepareDirectImportMock.mockResolvedValueOnce({
            success: true,
            uploadId: 'direct-upload-expired-recovery',
            destDisplayPath: '/repo/hello.txt',
            expectedSizeBytes: 5,
            chunkSizeBytes: 5,
            recipientPublicKeyBase64: Buffer.alloc(32, 9).toString('base64'),
            expiresAt: Date.now() - 1,
            endpointCandidates: [{
                kind: 'https',
                url: 'https://machine.example.test/machine-transfers/direct/imports/direct-upload-expired-recovery',
                expiresAt: Date.now() + 60_000,
            }],
        });
        let finalizeAttempts = 0;
        setRuntimeFetch(async (input, init) => {
            const url = String(input);
            if (url.endsWith('/chunks/0') && init?.method === 'PUT') {
                return new Response(JSON.stringify({ success: true }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            if (url.endsWith('/finalize') && init?.method === 'POST') {
                finalizeAttempts += 1;
                if (finalizeAttempts === 2) {
                    return new Response(JSON.stringify({
                        success: false,
                        error: 'Upload session not found',
                    }), {
                        status: 404,
                        headers: { 'content-type': 'application/json' },
                    });
                }
                return new Response(JSON.stringify({
                    success: false,
                    error: 'Finalize recovery is required',
                    errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED',
                    keepSession: true,
                }), {
                    status: 500,
                    headers: { 'content-type': 'application/json' },
                });
            }
            throw new Error(`unexpected request: ${String(init?.method)} ${url}`);
        });

        const relay = createRelay();
        const result = await uploadBulkPayloadFromFileWithCarrierFallbacks<UploadResult>({
            machineId: 'machine-1',
            serverId: 'server-1',
            fileReader: createReader(async () => {}),
            directImportRequest: {
                t: 'session_file_upload_v1',
                workingDirectory: '/repo',
                path: '/repo/hello.txt',
                sizeBytes: 5,
                overwrite: true,
            },
            relay,
        });
        if (result.success || !('recovery' in result) || !result.recovery) {
            throw new Error('expected finalize recovery continuation');
        }

        await expect(result.recovery.invoke('retry_finalize')).resolves.toEqual({
            status: 'unavailable',
            reason: 'session_unavailable',
            error: 'The staged upload is no longer available',
        });
        await expect(result.recovery.invoke('discard_staged')).resolves.toEqual({
            status: 'unavailable',
            reason: 'session_unavailable',
            error: 'The staged upload is no longer available',
        });
        expect(finalizeAttempts).toBe(2);
        expect(prepareDirectImportMock).toHaveBeenCalledTimes(1);
        expect(relay.init).not.toHaveBeenCalled();
        expect(relay.finalize).not.toHaveBeenCalled();
    });

    it('reports a missing retained session as unavailable when discarding', async () => {
        const expiresAt = Date.now() + 60_000;
        prepareDirectImportMock
            .mockResolvedValueOnce({
                success: true,
                uploadId: 'direct-upload-missing-recovery',
                destDisplayPath: '/repo/hello.txt',
                expectedSizeBytes: 5,
                chunkSizeBytes: 5,
                recipientPublicKeyBase64: Buffer.alloc(32, 9).toString('base64'),
                expiresAt,
                endpointCandidates: [{
                    kind: 'https',
                    url: 'https://machine.example.test/machine-transfers/direct/imports/direct-upload-missing-recovery',
                    expiresAt,
                }],
            })
            .mockResolvedValueOnce({ success: true });
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
                    headers: { 'content-type': 'application/json' },
                });
            }
            throw new Error(`unexpected request: ${String(init?.method)} ${url}`);
        });

        const relay = createRelay();
        const result = await uploadBulkPayloadFromFileWithCarrierFallbacks<UploadResult>({
            machineId: 'machine-1',
            serverId: 'server-1',
            fileReader: createReader(async () => {}),
            directImportRequest: {
                t: 'session_file_upload_v1',
                workingDirectory: '/repo',
                path: '/repo/hello.txt',
                sizeBytes: 5,
                overwrite: true,
            },
            relay,
        });
        if (result.success || !('recovery' in result) || !result.recovery) {
            throw new Error('expected finalize recovery continuation');
        }

        await expect(result.recovery.invoke('discard_staged')).resolves.toEqual({
            status: 'unavailable',
            reason: 'session_unavailable',
            error: 'The staged upload could not be discarded because its session is unavailable',
        });
        expect(prepareDirectImportMock).toHaveBeenCalledTimes(2);
        expect(relay.init).not.toHaveBeenCalled();
        expect(relay.finalize).not.toHaveBeenCalled();
    });

    it('fails closed without network effects for an invalid recovery action', async () => {
        const expiresAt = Date.now() + 60_000;
        prepareDirectImportMock.mockResolvedValueOnce({
            success: true,
            uploadId: 'direct-upload-invalid-action',
            destDisplayPath: '/repo/hello.txt',
            expectedSizeBytes: 5,
            chunkSizeBytes: 5,
            recipientPublicKeyBase64: Buffer.alloc(32, 9).toString('base64'),
            expiresAt,
            endpointCandidates: [{
                kind: 'https',
                url: 'https://machine.example.test/machine-transfers/direct/imports/direct-upload-invalid-action',
                expiresAt,
            }],
        });
        let finalizeAttempts = 0;
        setRuntimeFetch(async (input, init) => {
            const url = String(input);
            if (url.endsWith('/chunks/0') && init?.method === 'PUT') {
                return new Response(JSON.stringify({ success: true }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            if (url.endsWith('/finalize') && init?.method === 'POST') {
                finalizeAttempts += 1;
                return new Response(JSON.stringify({
                    success: false,
                    error: 'Finalize recovery is required',
                    errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED',
                    keepSession: true,
                }), {
                    status: 500,
                    headers: { 'content-type': 'application/json' },
                });
            }
            throw new Error(`unexpected request: ${String(init?.method)} ${url}`);
        });

        const relay = createRelay();
        const result = await uploadBulkPayloadFromFileWithCarrierFallbacks<UploadResult>({
            machineId: 'machine-1',
            fileReader: createReader(async () => {}),
            directImportRequest: {
                t: 'session_file_upload_v1',
                workingDirectory: '/repo',
                path: '/repo/hello.txt',
                sizeBytes: 5,
                overwrite: true,
            },
            relay,
        });
        if (result.success || !('recovery' in result) || !result.recovery) {
            throw new Error('expected finalize recovery continuation');
        }

        const invokeUnknown = result.recovery.invoke as (action: unknown) => Promise<unknown>;
        await expect(invokeUnknown('typo')).resolves.toEqual({
            status: 'unavailable',
            reason: 'invalid_action',
            error: 'Unsupported transfer recovery action',
        });
        expect(finalizeAttempts).toBe(1);
        expect(prepareDirectImportMock).toHaveBeenCalledTimes(1);
        expect(relay.init).not.toHaveBeenCalled();
    });

    it.each([
        {
            caseName: 'generic failure',
            finalizeBody: {
                success: false,
                error: 'unexpected finalize failure',
            },
        },
        {
            caseName: 'recovery code without retained-session authority',
            finalizeBody: {
                success: false,
                error: 'Finalize recovery is required',
                errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED',
                keepSession: false,
            },
        },
        {
            caseName: 'recovery response with an unknown field',
            finalizeBody: {
                success: false,
                error: 'Finalize recovery is required',
                errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED',
                keepSession: true,
                retryAfterMs: 1_000,
            },
        },
        {
            caseName: 'oversized otherwise-exact recovery response',
            finalizeBody: `${JSON.stringify({
                success: false,
                error: 'Finalize recovery is required',
                errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED',
                keepSession: true,
            })}${' '.repeat(8 * 1024)}`,
        },
    ])('keeps non-authoritative $caseName finalize behavior indeterminate', async ({ finalizeBody }) => {
        prepareDirectImportMock
            .mockResolvedValueOnce({
                success: true,
                uploadId: 'direct-upload-finalize-500',
                destDisplayPath: '/repo/hello.txt',
                expectedSizeBytes: 5,
                chunkSizeBytes: 5,
                recipientPublicKeyBase64: Buffer.alloc(32, 9).toString('base64'),
                expiresAt: 5_000,
                endpointCandidates: [{
                    kind: 'https',
                    url: 'https://machine.example.test/machine-transfers/direct/imports/direct-upload-finalize-500',
                    expiresAt: 5_000,
                }],
            })
            .mockResolvedValueOnce({ success: true });
        setRuntimeFetch(async (input, init) => {
            const url = String(input);
            if (url.endsWith('/chunks/0') && init?.method === 'PUT') {
                return new Response(JSON.stringify({ success: true }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            if (url.endsWith('/finalize') && init?.method === 'POST') {
                return new Response(typeof finalizeBody === 'string'
                    ? finalizeBody
                    : JSON.stringify(finalizeBody), {
                    status: 500,
                    headers: { 'content-type': 'application/json' },
                });
            }
            throw new Error(`unexpected request: ${String(init?.method)} ${url}`);
        });

        const relay = createRelay();
        const result = await uploadBulkPayloadFromFileWithCarrierFallbacks<UploadResult>({
            machineId: 'machine-1',
            serverId: 'server-1',
            fileReader: createReader(async () => {}),
            directImportRequest: {
                t: 'session_file_upload_v1',
                workingDirectory: '/repo',
                path: '/repo/hello.txt',
                sizeBytes: 5,
                overwrite: true,
            },
            relay,
        });

        expect(result).toMatchObject({
            success: false,
            errorCode: 'DIRECT_IMPORT_FINALIZE_OUTCOME_INDETERMINATE',
        });
        expect(prepareDirectImportMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            method: RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_ABORT,
            payload: { uploadId: 'direct-upload-finalize-500' },
        }));
        expect(relay.init).not.toHaveBeenCalled();
        expect(relay.sendChunk).not.toHaveBeenCalled();
        expect(relay.finalize).not.toHaveBeenCalled();
    });

    it('does not start a relay upload after caller cancellation', async () => {
        prepareDirectImportMock.mockResolvedValueOnce({
            success: false,
            error: 'Direct import endpoints unavailable',
        });
        const close = vi.fn(async () => {});
        const relay = createRelay();
        const controller = new AbortController();
        controller.abort(new Error('cancelled'));

        const result = await uploadBulkPayloadFromFileWithCarrierFallbacks<UploadResult>({
            machineId: 'machine-1',
            serverId: 'server-1',
            fileReader: createReader(close),
            directImportRequest: {
                t: 'session_file_upload_v1',
                workingDirectory: '/repo',
                path: '/repo/hello.txt',
                sizeBytes: 5,
                overwrite: true,
            },
            relay,
            signal: controller.signal,
        });

        expect(result).toEqual({
            success: false,
            error: 'Direct import upload unavailable',
        });
        expect(relay.init).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalledTimes(1);
    });
});
