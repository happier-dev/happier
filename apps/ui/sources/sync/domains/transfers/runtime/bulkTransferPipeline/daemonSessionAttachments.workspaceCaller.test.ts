import { describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const state = vi.hoisted(() => ({
    createdCallerParams: null as any,
    calledMethods: [] as string[],
    initRequest: null as any,
}));

vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    readMachineTargetForSession: () => ({ machineId: 'machine-1', basePath: '/repo' }),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: () => 'server-1',
}));

vi.mock('./workspaceFileTransferRpcCaller', () => ({
    createWorkspaceFileTransferRpcCaller: (params: any) => {
        state.createdCallerParams = params;
        return {
            call: async (callParams: any) => {
                state.calledMethods.push(String(callParams.machineMethod ?? ''));
                if (callParams.machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT) {
                    state.initRequest = callParams.request;
                    return { success: true, uploadId: 'u1', chunkSizeBytes: 1, recipientPublicKeyBase64: 'k' };
                }
                if (callParams.machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_CHUNK) {
                    return { success: true };
                }
                if (callParams.machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_FINALIZE) {
                    return { success: true, path: '/repo/file', sizeBytes: 0, sha256: 'h' };
                }
                if (callParams.machineMethod === RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_ABORT) {
                    return { success: true };
                }
                return { success: false, error: 'unknown method' };
            },
        };
    },
}));

vi.mock('./uploadBulkPayloadFromFile', () => ({
    uploadBulkPayloadFromFile: async (params: any) => {
        await params.init();
        await params.sendChunk({});
        return await params.finalize({});
    },
}));

describe('daemonSessionAttachments', () => {
    it('routes workspace attachments through the shared workspace transfer caller', async () => {
        state.createdCallerParams = null;
        state.calledMethods = [];
        state.initRequest = null;

        const { uploadDaemonSessionAttachmentFromReader } = await import('../transferSubstrate/sessionAttachmentTransfers');
        const result = await uploadDaemonSessionAttachmentFromReader({
            sessionId: 's1',
            fileReader: {
                sizeBytes: 2,
                readBytes: async () => new Uint8Array(),
                close: async () => {},
            },
            request: {
                messageLocalId: 'm1',
                fileName: 'a.txt',
                sizeBytes: 2,
                uploadLocation: 'workspace',
                workspaceRelativeDir: '.',
                vcsIgnoreStrategy: 'none',
                vcsIgnoreWritesEnabled: false,
            },
        });

        expect(result.success).toBe(true);
        expect(state.createdCallerParams).toEqual({
            machineId: 'machine-1',
            serverId: 'server-1',
            transferSizeBytes: 2,
            workingDirectory: '/repo',
        });
        expect(state.calledMethods).toEqual([
            RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT,
            RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_CHUNK,
            RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_FINALIZE,
        ]);
        expect(state.calledMethods).not.toContain('session-rpc');
    });

    it('routes os_temp attachments through the shared workspace transfer caller without forcing a workspace root', async () => {
        state.createdCallerParams = null;
        state.calledMethods = [];
        state.initRequest = null;

        const { uploadDaemonSessionAttachmentFromReader } = await import('../transferSubstrate/sessionAttachmentTransfers');
        const result = await uploadDaemonSessionAttachmentFromReader({
            sessionId: 's1',
            fileReader: {
                sizeBytes: 3,
                readBytes: async () => new Uint8Array(),
                close: async () => {},
            },
            request: {
                messageLocalId: 'm2',
                fileName: 'b.txt',
                sizeBytes: 3,
                uploadLocation: 'os_temp',
                workspaceRelativeDir: '.happier/uploads',
                vcsIgnoreStrategy: 'none',
                vcsIgnoreWritesEnabled: false,
            },
        });

        expect(result.success).toBe(true);
        expect(state.calledMethods).toEqual([
            RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT,
            RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_CHUNK,
            RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_FINALIZE,
        ]);
    });

    it('passes the session workspace root to the attachment upload init request', async () => {
        state.createdCallerParams = null;
        state.calledMethods = [];
        state.initRequest = null;

        const { uploadDaemonSessionAttachmentFromReader } = await import('../transferSubstrate/sessionAttachmentTransfers');
        await uploadDaemonSessionAttachmentFromReader({
            sessionId: 's1',
            fileReader: {
                sizeBytes: 2,
                readBytes: async () => new Uint8Array(),
                close: async () => {},
            },
            request: {
                messageLocalId: 'm1',
                fileName: 'a.txt',
                sizeBytes: 2,
                uploadLocation: 'workspace',
                workspaceRelativeDir: '.happier/uploads',
                vcsIgnoreStrategy: 'none',
                vcsIgnoreWritesEnabled: false,
            },
        });

        expect(state.initRequest).toMatchObject({
            messageLocalId: 'm1',
            fileName: 'a.txt',
            workspaceRelativeDir: '.happier/uploads',
            workspaceRootPath: '/repo',
        });
    });
});
