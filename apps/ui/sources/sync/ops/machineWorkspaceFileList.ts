import {
    DaemonWorkspaceFileListRequestSchema,
    DaemonWorkspaceFileListResponseSchema,
    type DaemonWorkspaceFileListRequest,
    type DaemonWorkspaceFileListResponse,
    type DaemonWorkspaceFileListErrorCode,
} from '@happier-dev/protocol/machines/workspaceFiles';
import { FILESYSTEM_BROWSER_ACTION_IDS_V1 } from '@happier-dev/protocol/actions/filesystemActionFamily';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { FilesystemEffectFailureDetailsV1 } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { invokeWorkspaceFileSystemAction, projectWorkspaceFileSystemActionFailure } from './workspaceFileSystem/actionInvocation';
import { classifyWorkspaceFileRpcError, type WorkspaceFileRpcErrorCode } from './machineWorkspaceFileRpcError';
import { resolveMachineRpcTimeoutMs } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';

// Client failures are not daemon wire responses and must not expand its schema.
export type MachineWorkspaceFileListErrorCode = DaemonWorkspaceFileListErrorCode | WorkspaceFileRpcErrorCode | ActionExecuteFailure['errorCode'] | 'invalid_response';
export type MachineWorkspaceFileListResponse = DaemonWorkspaceFileListResponse
    | Readonly<{ ok: false; error: string; errorCode: MachineWorkspaceFileListErrorCode; details?: FilesystemEffectFailureDetailsV1 }>;

export async function machineWorkspaceFileList(
    machineId: string,
    input: DaemonWorkspaceFileListRequest,
    options?: Readonly<{
        serverId?: string | null;
        accountId?: string | null;
        timeoutMs?: number;
        signal?: AbortSignal;
        callerContext?: ActionExecutorContext;
    }>,
): Promise<MachineWorkspaceFileListResponse> {
    const payload = DaemonWorkspaceFileListRequestSchema.parse(input);
    // Bind the native scan allowance before Action admission/signing. Approval
    // wait precedes the scan and must not consume its execution budget.
    const admittedInput = { ...payload, budgetMs: payload.budgetMs ?? resolveMachineRpcTimeoutMs(options?.timeoutMs) };
    try {
        const result = await invokeWorkspaceFileSystemAction({ machineId, serverId: options?.serverId, rootPath: payload.rootPath },
            FILESYSTEM_BROWSER_ACTION_IDS_V1.listFiles, admittedInput, { ...options, accountId: options?.accountId ?? undefined });
        if (!result.ok) {
            const failure = projectWorkspaceFileSystemActionFailure(result);
            return { ok: false, error: failure.error, errorCode: failure.errorCode ?? 'invalid_response',
                ...(failure.details ? { details: failure.details } : {}) };
        }
        const response = result.result;
        const parsed = DaemonWorkspaceFileListResponseSchema.safeParse(response);
        return parsed.success ? parsed.data : { ok: false, error: 'invalid_response', errorCode: 'invalid_response' };
    } catch (error) {
        if (options?.signal?.aborted) throw error;
        const errorCode = classifyWorkspaceFileRpcError(error);
        return { ok: false, error: errorCode, errorCode };
    }
}
