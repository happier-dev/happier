import { RPC_ERROR_CODES, RPC_METHODS, type WorkspaceStatFileRequestV1 } from '@happier-dev/protocol/rpc';

import { resolveMachineAbsolutePath } from '@/sync/domains/fileSystem/resolveMachineAbsolutePath';

import { uploadBulkPayloadFromFileViaMachineCarrier } from '../plumbing/uploadBulkPayloadFromFileViaMachineCarrier';
import type { TransferFinalizeRecoveryFailure } from '../plumbing/directTransferFinalizeRecovery';
import { resolveMachineCarrierRoute } from '../plumbing/machineCarrierHttpLease';
import { downloadBulkPayloadViaDirectExportToDestination } from '../plumbing/directTransferExportDownload';
import { captureFilesystemTransferAccountScope } from '../plumbing/filesystemTransferAccountScope';

import { createBufferedTransferDestination } from '../carriers/createBufferedTransferDestination';
import { createWorkspaceFileTransferRpcCaller } from './workspaceFileTransferRpcCaller';

type WorkspaceRpcFailure = Readonly<{ success: false; error: string; errorCode?: string }>;
type TransferFailureResponse = Readonly<{ success: false; error: string; errorCode?: string }>;
type TransferFileReader = Readonly<{
    sizeBytes: number;
    readBytes: (offset: number, length: number) => Promise<Uint8Array>;
    close: () => Promise<void>;
}>;
type TransferFileDestination = Readonly<{
    writeBytes: (bytes: Uint8Array) => Promise<void>;
    close: () => Promise<void>;
    cleanup?: (() => Promise<void>) | null;
}>;

type WorkspaceStatFileRequest = WorkspaceStatFileRequestV1;

type WorkspaceStatFileResponse =
    | Readonly<{
        success: true;
        exists: boolean;
        kind?: 'file' | 'directory' | 'other';
        sizeBytes?: number;
        modifiedMs?: number;
        /** Status-change time retained for metadata consumers. */
        changedMs?: number;
        /** SHA-256 of the file bytes when the daemon can provide an exact revision. */
        contentHash?: string;
      }>
    | WorkspaceRpcFailure;

type WorkspaceFileUploadInitRequest = Readonly<{
    path: string;
    sizeBytes: number;
    overwrite?: boolean;
    sha256?: string;
}>;

export type WorkspaceFileUploadFinalizeResponse =
    | Readonly<{ success: true; path: string; sizeBytes: number; sha256: string }>
    | WorkspaceRpcFailure;

export type WorkspaceWriteFileRpcRequest = Readonly<{
    path: string;
    content: string;
    expectedHash?: string | null;
}>;

export type WorkspaceWriteFileRpcResponse =
    | Readonly<{ success: true; hash: string }>
    | WorkspaceRpcFailure;

function resolveAbsoluteWorkspacePath(params: Readonly<{
    rootPath: string;
    agentRootPath?: string | null;
    requestPath: string;
}>): string {
    return resolveMachineAbsolutePath({
        rootPath: params.rootPath,
        agentRootPath: params.agentRootPath,
        requestPath: params.requestPath,
        pathKind: 'workspace_entry',
    });
}

export async function callDaemonWorkspaceStatFileRpc(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    rootPath: string;
    agentRootPath?: string | null;
    request: Readonly<{ path: string }>;
    timeoutMs?: number | null;
    signal?: AbortSignal | null;
    includeContentHash?: boolean;
}>): Promise<WorkspaceStatFileResponse> {
    const transferClient = createWorkspaceFileTransferRpcCaller({
        machineId: params.machineId,
        ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
    });

    return await transferClient.call<WorkspaceStatFileResponse, WorkspaceStatFileRequest>({
        request: {
            path: resolveAbsoluteWorkspacePath({ rootPath: params.rootPath, agentRootPath: params.agentRootPath, requestPath: params.request.path }),
            ...(params.includeContentHash ? { includeContentHash: true } : {}),
        },
        machineMethod: RPC_METHODS.STAT_FILE,
        timeoutMs: params.timeoutMs ?? null,
        ...(params.signal ? { signal: params.signal } : {}),
    });
}

export async function callDaemonWorkspaceWriteFileRpc(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    rootPath: string;
    agentRootPath?: string | null;
    request: WorkspaceWriteFileRpcRequest;
}>): Promise<WorkspaceWriteFileRpcResponse> {
    const transferClient = createWorkspaceFileTransferRpcCaller({
        machineId: params.machineId,
        ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
    });

    return await transferClient.call<WorkspaceWriteFileRpcResponse, WorkspaceWriteFileRpcRequest>({
        request: {
            ...params.request,
            path: resolveAbsoluteWorkspacePath({ rootPath: params.rootPath, agentRootPath: params.agentRootPath, requestPath: params.request.path }),
        },
        machineMethod: RPC_METHODS.WRITE_FILE,
    });
}

export async function uploadDaemonWorkspaceFileFromReader(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    rootPath: string;
    agentRootPath?: string | null;
    fileReader: TransferFileReader;
    request: WorkspaceFileUploadInitRequest;
    signal?: AbortSignal | null;
    onProgress?: ((progress: Readonly<{ uploadedBytes: number; totalBytes: number }>) => void) | null;
}>): Promise<
    WorkspaceFileUploadFinalizeResponse
    | TransferFailureResponse
    | TransferFinalizeRecoveryFailure<WorkspaceFileUploadFinalizeResponse>
> {
    const absolutePath = resolveAbsoluteWorkspacePath({ rootPath: params.rootPath, agentRootPath: params.agentRootPath, requestPath: params.request.path });
    return await uploadBulkPayloadFromFileViaMachineCarrier<WorkspaceFileUploadFinalizeResponse>({
        machineId: params.machineId,
        ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
        fileReader: params.fileReader,
        directImportRequest: {
            t: 'session_file_upload_v1',
            workingDirectory: params.rootPath,
            path: absolutePath,
            sizeBytes: params.fileReader.sizeBytes,
            overwrite: params.request.overwrite === true,
            ...(typeof params.request.sha256 === 'string' ? { sha256: params.request.sha256 } : {}),
        },
        onProgress: params.onProgress ?? null,
        signal: params.signal ?? null,
    });
}

async function downloadWorkspaceFileToDestination(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    rootPath: string;
    agentRootPath?: string | null;
    request: Readonly<{ path: string; asZip: boolean }>;
    destination: TransferFileDestination;
    confinedToWorkingDirectory?: boolean;
    onInit?: ((init: Readonly<{ name: string; sizeBytes: number }>) => Promise<void | TransferFailureResponse>) | null;
    signal?: AbortSignal | null;
    onProgress?: ((progress: Readonly<{ downloadedBytes: number; totalBytes: number }>) => void) | null;
}>, capturedAccount?: Awaited<ReturnType<typeof captureFilesystemTransferAccountScope>>): Promise<Readonly<{ ok: true; name: string; sizeBytes: number }> | Readonly<{ ok: false; error: string; errorCode?: string }>> {
    if (typeof params.destination.cleanup !== 'function') {
        return {
            ok: false,
            error: 'Workspace file download destination cleanup is required for retry-safe transfers',
        };
    }

    const absolutePath = resolveAbsoluteWorkspacePath({ rootPath: params.rootPath, agentRootPath: params.agentRootPath, requestPath: params.request.path });
    const directExportRequest = {
        t: 'workspace_file_download_v1',
        workingDirectory: params.rootPath,
        path: absolutePath,
        asZip: params.request.asZip,
        ...(params.confinedToWorkingDirectory ? { confinedToWorkingDirectory: true } : {}),
    } as const;

    if (params.signal?.aborted) {
        await params.destination.cleanup();
        return { ok: false, error: 'Download canceled' };
    }
    let account: Awaited<ReturnType<typeof captureFilesystemTransferAccountScope>> | undefined;
    try {
        const captured = account = capturedAccount ?? await captureFilesystemTransferAccountScope(params.serverId, params.signal);
        captured.assertCurrent();
        const machineRoute = await resolveMachineCarrierRoute(params.machineId, captured.serverId);
        captured.assertCurrent();
        if (machineRoute.kind === 'unavailable') {
            await params.destination.cleanup();
            return { ok: false, error: machineRoute.error, errorCode: machineRoute.errorCode };
        }
        const result = await downloadBulkPayloadViaDirectExportToDestination({
            machineId: params.machineId,
            serverId: machineRoute.serverId,
            accountId: captured.accountId,
            request: directExportRequest,
            destination: params.destination,
            onInit: params.onInit ?? null,
            signal: captured.signal,
            onProgress: params.onProgress ?? null,
            acquirePreparedCarrier: async ({ operationId }) => await machineRoute.acquire({
                operationId,
                signal: captured.signal,
                accountLifetime: captured.accountLifetime,
            }),
            acquireCleanupCarrier: async ({ operationId }) => {
                captured.assertAccountCurrent();
                return await machineRoute.acquire({ operationId, accountLifetime: captured.accountOnlyLifetime });
            },
        });
        captured.assertCurrent();
        return result;
    } catch (error) {
        await params.destination.cleanup();
        return { ok: false, error: error instanceof Error ? error.message : 'Download Account custody is unavailable', errorCode: 'action_account_scope_changed' };
    } finally { if (!capturedAccount) account?.dispose(); }
}

export async function downloadDaemonWorkspaceFileToDestination(params: Parameters<typeof downloadWorkspaceFileToDestination>[0]) {
    return await downloadWorkspaceFileToDestination(params);
}

export async function downloadDaemonWorkspaceFileToBase64(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    rootPath: string;
    agentRootPath?: string | null;
    path: string;
    maxBytes: number;
    signal?: AbortSignal | null;
}>): Promise<Readonly<{ ok: true; contentBase64: string }> | Readonly<{ ok: false; error: string; errorCode?: string }>> {
    let account: Awaited<ReturnType<typeof captureFilesystemTransferAccountScope>> | undefined;
    try {
    account = await captureFilesystemTransferAccountScope(params.serverId, params.signal);
    account.assertCurrent();
    const statClient = createWorkspaceFileTransferRpcCaller({
        machineId: params.machineId,
        serverId: account.serverId,
        accountId: account.accountId,
    });
    const absolutePath = resolveAbsoluteWorkspacePath({ rootPath: params.rootPath, agentRootPath: params.agentRootPath, requestPath: params.path });
    const stat = await statClient.call<WorkspaceStatFileResponse, WorkspaceStatFileRequest>({
        request: { path: absolutePath },
        machineMethod: RPC_METHODS.STAT_FILE,
        signal: account.signal,
    });
    account.assertCurrent();
    if (stat.success !== true) {
        return { ok: false, error: stat.error, ...(stat.errorCode ? { errorCode: stat.errorCode } : {}) };
    }
    if (!stat.exists) {
        return { ok: false, error: 'File does not exist', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE };
    }
    if (stat.kind && stat.kind !== 'file') {
        return { ok: false, error: 'Path is not a file', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE };
    }
    if (typeof stat.sizeBytes !== 'number' || !Number.isFinite(stat.sizeBytes) || stat.sizeBytes < 0) {
        return { ok: false, error: 'Unable to resolve file size', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE };
    }

    const fileSizeBytes = Math.floor(stat.sizeBytes);
    if (fileSizeBytes > params.maxBytes) {
        return {
            ok: false,
            error: 'File exceeds the inline file read size limit',
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        };
    }

    const createInlineBufferedDestination = () => createBufferedTransferDestination(params.maxBytes);

    const directBufferedDestination = createInlineBufferedDestination();
    const directExportResult = await downloadWorkspaceFileToDestination({
        machineId: params.machineId,
        serverId: account.serverId,
        rootPath: params.rootPath,
        agentRootPath: params.agentRootPath,
        request: { path: absolutePath, asZip: false },
        destination: directBufferedDestination.destination,
        onInit: async (init) => {
            if (init.sizeBytes > params.maxBytes) {
                return {
                    success: false as const,
                    error: 'File exceeds the inline file read size limit',
                };
            }
        },
        signal: params.signal ?? null,
    }, account);
    if (directExportResult.ok) {
        return {
            ok: true,
            contentBase64: directBufferedDestination.toBase64(),
        };
    }
    return directExportResult;
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Download Account custody is unavailable', errorCode: 'action_account_scope_changed' };
    } finally { account?.dispose(); }
}
