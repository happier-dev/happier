import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { StructuredQuestionResponseV1 } from '@happier-dev/protocol';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { sessionRpcWithPreferredSessionScope } from '@/sync/runtime/orchestration/serverScopedRpc/sessionRpcWithPreferredSessionScope';
import { sessionRpcWithServerScope, sessionRpcWithServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';

/** One structured-question operation shared by session UI, actions and native replies. */
export async function sessionRespondToStructuredQuestion(params: Readonly<{
    sessionId: string;
    request: StructuredQuestionResponseV1;
    target?: Readonly<{ scope: ServerAccountScope }> | Readonly<{ serverId?: string | null }>;
    networkMode?: 'background-task';
    signal?: AbortSignal;
    onIssued?: () => void;
}>): Promise<unknown> {
    const request = {
        sessionId: params.sessionId,
        method: SESSION_RPC_METHODS.SESSION_STRUCTURED_QUESTION_RESPOND_V1,
        payload: params.request,
        onIssued: params.onIssued,
    };
    if (params.target && 'scope' in params.target) {
        return sessionRpcWithServerAccountScope({ ...request, scope: params.target.scope,
            networkMode: params.networkMode, signal: params.signal });
    }
    if (params.target && 'serverId' in params.target) {
        return sessionRpcWithServerScope({ ...request, serverId: params.target.serverId });
    }
    return sessionRpcWithPreferredSessionScope(request);
}
