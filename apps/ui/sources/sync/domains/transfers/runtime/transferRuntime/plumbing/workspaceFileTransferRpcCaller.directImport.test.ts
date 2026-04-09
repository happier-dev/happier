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

        if (params.method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT) {
            return {
                success: true,
                uploadId: 'direct-upload-1',
                chunkSizeBytes: 8,
                recipientPublicKeyBase64: 'recipient-key',
                destDisplayPath: 'nested/file.txt',
                expectedSizeBytes: 4,
                expiresAt: 2_000,
            };
        }
        if (params.method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK) {
            return { success: true };
        }
        if (params.method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE) {
            return { success: true, path: 'nested/file.txt', sizeBytes: 4, sha256: 'sha256:test' };
        }

        throw new Error(`Unexpected machine RPC method: ${params.method}`);
    }),
}));

vi.mock('../routing/resolvePreferScopedMachineRpc', () => ({
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
    it('passes canonical upload RPC methods through the guarded machine RPC client', async () => {
        state.machineRpcCalls = [];
        state.fetchCalls = [];

        const { createWorkspaceFileTransferRpcCaller } = await import('../families/workspaceFileTransferRpcCaller');
        const caller = createWorkspaceFileTransferRpcCaller({
            machineId: 'machine-1',
            serverId: 'server-1',
        });

        const init = await caller.call<
            Readonly<{ success: true; uploadId: string; chunkSizeBytes: number; recipientPublicKeyBase64: string }>,
            Readonly<{ t: 'session_file_upload_v1'; path: string; sizeBytes: number; overwrite: boolean }>
        >({
            machineMethod: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT,
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
                method: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT,
                preferScoped: true,
            }),
        ]);
        expect(state.fetchCalls).toHaveLength(0);

        await expect(caller.call({
            machineMethod: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK,
            request: {
                uploadId: 'direct-upload-1',
                index: 0,
                payloadBase64: 'YQ==',
                encryptedDataKeyEnvelopeBase64: 'Yg==',
            },
        })).resolves.toEqual({ success: true });

        await expect(caller.call({
            machineMethod: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE,
            request: { uploadId: 'direct-upload-1' },
        })).resolves.toEqual({ success: true, path: 'nested/file.txt', sizeBytes: 4, sha256: 'sha256:test' });

        expect(state.machineRpcCalls).toEqual([
            expect.objectContaining({
                method: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT,
                preferScoped: true,
            }),
            expect.objectContaining({
                method: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK,
                preferScoped: true,
            }),
            expect.objectContaining({
                method: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE,
                preferScoped: true,
            }),
        ]);
        expect(state.fetchCalls).toHaveLength(0);
    });

    it('returns a fail-closed transfer error when the guarded machine RPC throws', async () => {
        state.machineRpcCalls = [];
        state.fetchCalls = [];

        const { createWorkspaceFileTransferRpcCaller } = await import('../families/workspaceFileTransferRpcCaller');
        const caller = createWorkspaceFileTransferRpcCaller({
            machineId: 'machine-1',
            serverId: 'server-1',
        });

        vi.mocked((await import('@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc')).callGuardedMachineRpcWithPolicy)
            .mockRejectedValueOnce(new Error('rpc exploded'));

        await expect(caller.call({
            machineMethod: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT,
            request: {
                t: 'session_file_upload_v1',
                path: 'nested/file.txt',
                sizeBytes: 4,
                overwrite: true,
            },
        })).resolves.toEqual({
            success: false,
            error: 'rpc exploded',
            errorCode: undefined,
        });
        expect(state.fetchCalls).toHaveLength(0);
    });
});
