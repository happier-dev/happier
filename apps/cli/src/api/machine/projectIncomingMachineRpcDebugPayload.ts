import {
    AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1,
    SESSION_SERVER_START_DAEMON_RPC_METHOD_V1,
} from '@happier-dev/protocol';

/**
 * Reserved server-origin parameters can contain private plain or encrypted
 * envelopes. Keep the generic RPC debug facility useful for method diagnostics
 * without turning it into a content-retention path.
 */
export function projectIncomingMachineRpcDebugPayload(data: Readonly<{
    method: string;
    params: unknown;
}>): Readonly<{ method: string; params: unknown }> {
    if (
        data.method === AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1
        || data.method.endsWith(`:${AUTOMATION_REPLY_HANDOFF_DAEMON_RPC_METHOD_V1}`)
    ) {
        return {
            method: data.method,
            params: '[redacted: automation reply-handoff content]',
        };
    }
    if (
        data.method === SESSION_SERVER_START_DAEMON_RPC_METHOD_V1
        || data.method.endsWith(`:${SESSION_SERVER_START_DAEMON_RPC_METHOD_V1}`)
    ) {
        return {
            method: data.method,
            params: '[redacted: Session server-start content]',
        };
    }
    return data;
}
