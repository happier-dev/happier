import type { ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readActionFailureEnvelope, readMachineActionRpcResult } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

export type LocalServiceRpcFailureMetadata = Readonly<{
    reasonCode?: string;
    failureCause?: ActionFailureCauseV1;
}>;

/** Project the transport owner's typed evidence without forwarding private error prose. */
export function readLocalServiceRpcFailure(value: unknown): LocalServiceRpcFailureMetadata | null {
    let carrier = value;
    try { carrier = readMachineActionRpcResult(value); }
    catch (error) { carrier = error; }
    const rpcErrorCode = readRpcErrorCode(carrier);
    const failure = readActionFailureEnvelope(
        rpcErrorCode && carrier && typeof carrier === 'object'
            ? { ...carrier, ok: false, errorCode: rpcErrorCode }
            : carrier,
        { treatReturnedErrorEnvelopeAsFailure: true },
    );
    return failure ? { reasonCode: failure.errorCode,
        ...(failure.failureCause ? { failureCause: failure.failureCause } : {}) } : null;
}
