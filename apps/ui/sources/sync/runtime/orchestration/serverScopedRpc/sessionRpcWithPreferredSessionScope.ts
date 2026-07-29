import { resolvePreferredServerIdForSessionId } from './resolvePreferredServerIdForSessionId';
import { sessionRpcWithServerScope } from './serverScopedSessionRpc';

export async function sessionRpcWithPreferredSessionScope<R, A>(params: Readonly<{
    sessionId: string;
    method: string;
    payload: A;
    timeoutMs?: number;
    onIssued?: () => void;
}>): Promise<R> {
    return await sessionRpcWithServerScope<R, A>({
        sessionId: params.sessionId,
        serverId: resolvePreferredServerIdForSessionId(params.sessionId),
        method: params.method,
        payload: params.payload,
        timeoutMs: params.timeoutMs,
        onIssued: params.onIssued,
    });
}
