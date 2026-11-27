import { classifyWorkspaceFileRpcUnavailable } from '@happier-dev/protocol/machines/codeIntelligenceFallback';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

export type WorkspaceFileRpcErrorCode = NonNullable<ReturnType<typeof classifyWorkspaceFileRpcUnavailable>> | 'transport_failed';

/** Client transport projection shared by workspace filename and content adapters. */
export function classifyWorkspaceFileRpcError(error: unknown): WorkspaceFileRpcErrorCode {
    return classifyWorkspaceFileRpcUnavailable(readRpcErrorCode(error)) ?? 'transport_failed';
}
