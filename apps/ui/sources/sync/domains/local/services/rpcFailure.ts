import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readActionFailureEnvelope, readMachineActionRpcResult } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

export type LocalServiceRpcFailureMetadata = Readonly<{
    reasonCode?: string;
    failure?: ActionExecuteFailure;
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
    if (!failure) return null;
    return { reasonCode: failure.errorCode, failure: { ...failure, error: failure.errorCode } };
}
