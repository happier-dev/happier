import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { deriveWorkspaceSyncConflictOperationId } from '@happier-dev/protocol';

import { registerMachineDirectTransferExportRpcHandlers } from './rpcHandlers.directTransferExports';
import type { RpcHandlerRegistrar } from '../rpc/types';
import { resolveWorkspaceFileDownloadSource } from '@/transfers/targets/resolveWorkspaceFileDownloadSource';

type Handler = (data: unknown) => Promise<unknown>;

function createRpcHandlerRegistrar(): {
    handlers: Map<string, Handler>;
    registrar: RpcHandlerRegistrar;
} {
    const handlers = new Map<string, Handler>();
    return {
        handlers,
        registrar: {
            registerHandler(method, handler) {
                handlers.set(method, async (data) => await handler(data as never));
            },
        },
    };
}

describe('direct transfer export request validation', () => {
    it('admits publication confinement to the real file source and preserves ordinary exports', async () => {
        const root = await mkdtemp(join(tmpdir(), 'artifact-export-admission-'));
        try {
            const workspace = join(root, 'workspace');
            await mkdir(workspace);
            await writeFile(join(workspace, 'inside.txt'), 'inside');
            await writeFile(join(root, 'outside.txt'), 'outside');
            const registrar = createRpcHandlerRegistrar();
            registerMachineDirectTransferExportRpcHandlers({ rpcHandlerManager: registrar.registrar,
                prepareExportSession: async request => {
                    if (request.t !== 'workspace_file_download_v1') throw new Error('Unexpected export');
                    const source = await resolveWorkspaceFileDownloadSource({ ...request,
                        confinedToWorkingDirectory: Reflect.get(request, 'confinedToWorkingDirectory') === true });
                    if (!source.success) throw new Error(source.error);
                    return { transferId: source.source.name, endpointCandidates: [], expiresAt: 9000, sizeBytes: source.source.sizeBytes };
                } });
            const handler = registrar.handlers.get(RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE)!;
            const request = { t: 'workspace_file_download_v1', workingDirectory: workspace, asZip: false };
            await expect(handler({ ...request, path: 'inside.txt', confinedToWorkingDirectory: true }))
                .resolves.toMatchObject({ success: true, transferId: 'inside.txt', sizeBytes: 6 });
            await expect(handler({ ...request, path: '../outside.txt', confinedToWorkingDirectory: true }))
                .resolves.toMatchObject({ success: false });
            await expect(handler({ ...request, path: '../outside.txt' }))
                .resolves.toMatchObject({ success: true, transferId: 'outside.txt', sizeBytes: 7 });
        } finally { await rm(root, { recursive: true, force: true }); }
    });
    it('accepts a valid workspace file export when reviewed resolution export is also registered', async () => {
        const prepareExportSession = vi.fn(async () => ({ transferId: 'workspace-export', endpointCandidates: [], expiresAt: 9_000 }));
        const registrar = createRpcHandlerRegistrar();
        registerMachineDirectTransferExportRpcHandlers({ rpcHandlerManager: registrar.registrar, prepareExportSession });
        const handler = registrar.handlers.get(RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE);
        if (!handler) throw new Error('expected direct transfer export prepare handler');
        const request = {
            t: 'workspace_file_download_v1' as const,
            workingDirectory: '/repo',
            path: 'file.txt',
            asZip: false,
        };

        await expect(handler(request)).resolves.toMatchObject({ success: true, transferId: 'workspace-export' });
        expect(prepareExportSession).toHaveBeenCalledWith(request);
    });

    it('accepts a reviewed resolution export only with the complete approved source and target expectation', async () => {
        const operationId = deriveWorkspaceSyncConflictOperationId({
            actionReceiptId: 'receipt-1', kind: 'selected', workspaceRefId: 'workspace-a', path: 'value.bin',
        });
        const prepareExportSession = vi.fn(async () => ({ transferId: operationId, endpointCandidates: [], expiresAt: 9_000 }));
        const registrar = createRpcHandlerRegistrar();
        registerMachineDirectTransferExportRpcHandlers({ rpcHandlerManager: registrar.registrar, prepareExportSession });
        const handler = registrar.handlers.get(RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE);
        if (!handler) throw new Error('expected direct transfer export prepare handler');
        const source = { kind: 'file' as const, digest: 'a'.repeat(40), executable: false, size: 3 };
        const target = { kind: 'file' as const, digest: 'b'.repeat(40), executable: false, size: 3 };
        const request = {
            t: 'workspace_sync_resolution_v1' as const,
            actionReceiptId: 'receipt-1',
            actionInput: {
                controllerMachineId: 'machine-a', hubWorkspaceRefId: 'workspace-a', path: 'value.bin',
                source: { workspaceRefId: 'workspace-b', expected: source },
                targets: [{ workspaceRefId: 'workspace-a', expected: target }],
                relationshipIds: ['relationship-1'], strategy: 'use_source' as const,
            },
            operationId, alternativeIndex: null, relationshipId: 'relationship-1', sourceRelationshipId: 'relationship-1',
            sourceMachineId: 'machine-b', sourceWorkspaceRefId: 'workspace-b', sourceExpected: source,
            targetMachineId: 'machine-a', targetWorkspaceRefId: 'workspace-a', targetExpected: target,
            path: 'value.bin',
        };
        await expect(handler(request)).resolves.toMatchObject({ success: true, transferId: operationId });
        expect(prepareExportSession).toHaveBeenCalledWith(request);
        await expect(handler({ ...request, targetExpected: undefined })).resolves.toMatchObject({ success: false });
        await expect(handler({ ...request, rootPath: '/unreviewed' })).resolves.toMatchObject({ success: false });
        expect(prepareExportSession).toHaveBeenCalledOnce();
    });
    it.each([
        {
            t: 'workspace_file_download_v1',
            workingDirectory: '/repo',
            path: '/repo/file.txt',
            asZip: 'false',
        },
        {
            t: 'workspace_file_download_v1',
            workingDirectory: '/repo',
            path: '/repo/file.txt',
        },
        {
            t: 'workspace_file_download_v1',
            workingDirectory: '/repo',
            path: '/repo/file.txt',
            asZip: false,
            unexpectedAuthority: true,
        },
    ])('rejects malformed workspace export request %# before calling the export owner', async (request) => {
        const prepareExportSession = vi.fn();
        const registrar = createRpcHandlerRegistrar();
        registerMachineDirectTransferExportRpcHandlers({
            rpcHandlerManager: registrar.registrar,
            prepareExportSession,
        });

        const handler = registrar.handlers.get(RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE);
        if (!handler) throw new Error('expected direct transfer export prepare handler');

        await expect(handler(request)).resolves.toEqual({
            success: false,
            error: 'Invalid direct transfer export request',
        });
        expect(prepareExportSession).not.toHaveBeenCalled();
    });
});
