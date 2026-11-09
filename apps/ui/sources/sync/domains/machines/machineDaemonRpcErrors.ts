import { isRpcMethodNotFoundError, isRpcError, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import type { ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

export type MachineDaemonRpcFailure = Readonly<{
    ok: false;
    reason: 'older_happier' | 'request_failed' | 'invalid_response';
    errorCode?: string;
    failureCause?: ActionFailureCauseV1;
}>;

/** Preserve the protocol's safe diagnostics once, for every Machine read surface. */
export function projectMachineDaemonRpcFailure(error: unknown): MachineDaemonRpcFailure {
    const errorCode = readRpcErrorCode(error);
    const failureCause = isRpcError(error) ? error.failureCause : undefined;
    return { ok: false, reason: isMachineDaemonRpcUnsupportedError(error) ? 'older_happier'
        : errorCode === 'invalid_action_output' ? 'invalid_response' : 'request_failed',
        ...(errorCode ? { errorCode } : {}), ...(failureCause ? { failureCause } : {}) };
}

/** Home or daemon must affirm method absence; routing/discovery unavailability is temporary. */
export function isMachineDaemonRpcUnsupportedError(error: unknown): boolean {
    return isRpcMethodNotFoundError(error);
}
