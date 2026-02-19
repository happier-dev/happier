import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { createRpcCallError } from './rpcErrors';

export function assertRpcResponseWithSuccess<T extends { success: boolean }>(value: unknown): T {
    if (!value || typeof value !== 'object' || typeof (value as { success?: unknown }).success !== 'boolean') {
        // Treat as incompatibility with older daemons/CLIs: callers expect a `{ success }` envelope.
        throw createRpcCallError({
            error: 'RPC call returned an unsupported response',
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        });
    }
    return value as T;
}

