import { describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const state = vi.hoisted(() => ({
    machineRpcCalls: [] as Array<{ method: string; payload: unknown; preferScoped?: boolean }>,
    fetchCalls: [] as Array<{ input: RequestInfo | URL; init?: RequestInit }>,
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc', () => ({
    callGuardedMachineRpcWithPolicy: vi.fn(async (params: {
        method: string;
        payload: unknown;
        preferScoped?: boolean;
    }) => {
        state.machineRpcCalls.push({
            method: params.method,
            payload: params.payload,
            preferScoped: params.preferScoped,
        });

        if (params.method === RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_PREPARE) {
            return {
                success: true,
                uploadId: 'direct-upload-1',
                chunkSizeBytes: 8,
                recipientPublicKeyBase64: 'recipient-key',
                destDisplayPath: 'nested/file.txt',
                expectedSizeBytes: 4,
                expiresAt: 2_000,
                endpointCandidates: [
                    {
                        kind: 'http' as const,
                        url: 'http://127.0.0.1:46001/machine-transfers/direct/imports/direct-upload-1',
                        expiresAt: 2_000,
                    },
                ],
            };
        }

        throw new Error(`Unexpected machine RPC method: ${params.method}`);
    }),
}));

vi.mock('../transferSubstrate/resolvePreferScopedMachineRpc', () => ({
    resolvePreferScopedMachineRpc: vi.fn(async () => true),
}));

vi.mock('@/utils/system/runtimeFetch', () => ({
    runtimeFetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        state.fetchCalls.push({ input, init });
        const url = String(input);
        if (url.endsWith('/machine-transfers/direct/imports/direct-upload-1/chunks/0')) {
            return new Response(JSON.stringify({ success: true }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }
        if (url.endsWith('/machine-transfers/direct/imports/direct-upload-1/finalize')) {
            return new Response(JSON.stringify({ success: true, path: 'nested/file.txt', sizeBytes: 4, sha256: 'sha256:test' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }
        if (url.endsWith('/machine-transfers/direct/imports/direct-upload-1/abort')) {
            return new Response(JSON.stringify({ success: true }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }
        throw new Error(`Unexpected runtimeFetch call: ${url}`);
    }),
}));

describe('workspaceFileTransferRpcCaller direct import', () => {
    it('uses the direct import control plane for session file upload init and streams later upload calls over HTTP', async () => {
        state.machineRpcCalls = [];
        state.fetchCalls = [];

        const { createWorkspaceFileTransferRpcCaller } = await import('./workspaceFileTransferRpcCaller');
        const caller = createWorkspaceFileTransferRpcCaller({
            machineId: 'machine-1',
            serverId: 'server-1',
            transferSizeBytes: 4,
            workingDirectory: '/repo',
        });

        const init = await caller.call<
            Readonly<{ success: true; uploadId: string; chunkSizeBytes: number; recipientPublicKeyBase64: string }>,
            Readonly<{ t: 'session_file_upload_v1'; path: string; sizeBytes: number; overwrite: boolean }>
        >({
            machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT,
            request: {
                t: 'session_file_upload_v1',
                path: 'nested/file.txt',
                sizeBytes: 4,
                overwrite: true,
            },
        });

        expect(init).toEqual({
            success: true,
            uploadId: 'direct-upload-1',
            chunkSizeBytes: 8,
            recipientPublicKeyBase64: 'recipient-key',
            destDisplayPath: 'nested/file.txt',
            expectedSizeBytes: 4,
            expiresAt: 2_000,
        });
        expect(state.machineRpcCalls).toEqual([
            expect.objectContaining({
                method: RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_PREPARE,
                preferScoped: true,
            }),
        ]);
        expect(state.fetchCalls).toHaveLength(0);

        await expect(caller.call({
            machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_CHUNK,
            request: {
                uploadId: 'direct-upload-1',
                index: 0,
                payloadBase64: 'YQ==',
                encryptedDataKeyEnvelopeBase64: 'Yg==',
            },
        })).resolves.toEqual({ success: true });

        await expect(caller.call({
            machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_FINALIZE,
            request: { uploadId: 'direct-upload-1' },
        })).resolves.toEqual({ success: true, path: 'nested/file.txt', sizeBytes: 4, sha256: 'sha256:test' });

        expect(state.machineRpcCalls).toHaveLength(1);
        expect(state.fetchCalls.map((call) => String(call.input))).toEqual([
            'http://127.0.0.1:46001/machine-transfers/direct/imports/direct-upload-1/chunks/0',
            'http://127.0.0.1:46001/machine-transfers/direct/imports/direct-upload-1/finalize',
        ]);
    });

    it('keeps the prepared direct import session alive long enough to finalize on a later endpoint candidate when the first one fails', async () => {
        state.machineRpcCalls = [];
        state.fetchCalls = [];

        const { createWorkspaceFileTransferRpcCaller } = await import('./workspaceFileTransferRpcCaller');
        const caller = createWorkspaceFileTransferRpcCaller({
            machineId: 'machine-1',
            serverId: 'server-1',
            transferSizeBytes: 4,
            workingDirectory: '/repo',
        });

        state.machineRpcCalls = [];
        state.fetchCalls = [];

        vi.mocked((await import('@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc')).callGuardedMachineRpcWithPolicy)
            .mockResolvedValueOnce({
                success: true,
                uploadId: 'direct-upload-2',
                chunkSizeBytes: 8,
                recipientPublicKeyBase64: 'recipient-key',
                destDisplayPath: 'nested/file.txt',
                expectedSizeBytes: 4,
                expiresAt: 2_000,
                endpointCandidates: [
                    {
                        kind: 'http' as const,
                        url: 'http://127.0.0.1:46001/machine-transfers/direct/imports/direct-upload-2',
                        expiresAt: 2_000,
                    },
                    {
                        kind: 'http' as const,
                        url: 'http://127.0.0.1:46002/machine-transfers/direct/imports/direct-upload-2',
                        expiresAt: 2_000,
                    },
                ],
            });

        const runtimeFetch = (await import('@/utils/system/runtimeFetch')).runtimeFetch as unknown as ReturnType<typeof vi.fn>;
        runtimeFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            state.fetchCalls.push({ input, init });

            if (url.startsWith('http://127.0.0.1:46001/') && url.endsWith('/chunks/0')) {
                return new Response(JSON.stringify({ success: true }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            if (url.startsWith('http://127.0.0.1:46001/') && url.endsWith('/finalize')) {
                return new Response(JSON.stringify({ success: false, error: 'first-finalize-failed' }), {
                    status: 500,
                    headers: { 'content-type': 'application/json' },
                });
            }
            if (url.startsWith('http://127.0.0.1:46002/') && url.endsWith('/finalize')) {
                return new Response(JSON.stringify({
                    success: true,
                    finalized: {
                        success: true,
                        path: 'nested/file.txt',
                        sizeBytes: 4,
                    },
                    sha256: 'sha256:test',
                }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }

            throw new Error(`Unexpected runtimeFetch call: ${url}`);
        });

        await expect(caller.call({
            machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT,
            request: {
                t: 'session_file_upload_v1',
                path: 'nested/file.txt',
                sizeBytes: 4,
                overwrite: true,
            },
        })).resolves.toEqual({
            success: true,
            uploadId: 'direct-upload-2',
            chunkSizeBytes: 8,
            recipientPublicKeyBase64: 'recipient-key',
            destDisplayPath: 'nested/file.txt',
            expectedSizeBytes: 4,
            expiresAt: 2_000,
        });

        await expect(caller.call({
            machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_CHUNK,
            request: {
                uploadId: 'direct-upload-2',
                index: 0,
                payloadBase64: 'YQ==',
                encryptedDataKeyEnvelopeBase64: 'Yg==',
            },
        })).resolves.toEqual({ success: true });

        await expect(caller.call({
            machineMethod: RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_FINALIZE,
            request: { uploadId: 'direct-upload-2' },
        })).resolves.toEqual({ success: true, path: 'nested/file.txt', sizeBytes: 4, sha256: 'sha256:test' });

        expect(state.fetchCalls.map((call) => String(call.input))).toEqual([
            'http://127.0.0.1:46001/machine-transfers/direct/imports/direct-upload-2/chunks/0',
            'http://127.0.0.1:46001/machine-transfers/direct/imports/direct-upload-2/finalize',
            'http://127.0.0.1:46002/machine-transfers/direct/imports/direct-upload-2/finalize',
        ]);
    });
});
