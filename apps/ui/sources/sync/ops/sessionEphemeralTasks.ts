import type { EphemeralTaskRunRequest, EphemeralTaskRunResponse } from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import { sessionRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';

export type SessionEphemeralTaskRunResult =
    | EphemeralTaskRunResponse
    | { ok: false; error: string; errorCode?: string };

export async function sessionEphemeralTaskRun(
    sessionId: string,
    request: EphemeralTaskRunRequest,
    opts?: Readonly<{ serverId?: string | null }>,
): Promise<SessionEphemeralTaskRunResult> {
    try {
        const response = await sessionRpcWithServerScope<EphemeralTaskRunResponse, EphemeralTaskRunRequest>({
            sessionId,
            serverId: opts?.serverId,
            method: SESSION_RPC_METHODS.EPHEMERAL_TASK_RUN,
            payload: request,
        });

        if (!response || typeof response !== 'object' || typeof (response as any).ok !== 'boolean') {
            return { ok: false, error: 'Unsupported response from session RPC' };
        }
        return response;
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error),
        };
    }
}

