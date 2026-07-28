import { isDelegatedSessionApprovalRpcMethod } from '@happier-dev/protocol/rpc';
import { isSocketRpcTargetFailureV1 } from '@happier-dev/protocol/rpcErrors';

export type ForwardedRpcResponse =
    | Readonly<{ ok: true; result: unknown }>
    | Readonly<{ ok: false; error: string; errorCode: string }>;

export function forwardedRpcTargetResponse(params: Readonly<{
    method: string;
    targetResponse: unknown;
}>): ForwardedRpcResponse {
    const separatorIndex = params.method.lastIndexOf(':');
    const suffix = separatorIndex >= 0 ? params.method.slice(separatorIndex + 1) : '';
    if (isDelegatedSessionApprovalRpcMethod(suffix) && isSocketRpcTargetFailureV1(params.targetResponse)) {
        return {
            ok: false,
            error: params.targetResponse.error,
            errorCode: params.targetResponse.errorCode,
        };
    }
    return { ok: true, result: params.targetResponse };
}
