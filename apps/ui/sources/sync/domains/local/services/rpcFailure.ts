import type { ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readActionFailureEnvelope } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

export type LocalServiceRpcFailureMetadata = Readonly<{
    reasonCode?: string;
    failureCause?: ActionFailureCauseV1;
}>;

/** Project the transport owner's typed evidence without forwarding private error prose. */
export function readLocalServiceRpcFailure(value: unknown): LocalServiceRpcFailureMetadata | null {
    const rpcErrorCode = readRpcErrorCode(value);
    const failure = readActionFailureEnvelope(
        rpcErrorCode && value && typeof value === 'object'
            ? { ...value, ok: false, errorCode: rpcErrorCode }
            : value,
        { treatReturnedErrorEnvelopeAsFailure: true },
    );
    return failure ? { reasonCode: failure.errorCode,
        ...(failure.failureCause ? { failureCause: failure.failureCause } : {}) } : null;
}
