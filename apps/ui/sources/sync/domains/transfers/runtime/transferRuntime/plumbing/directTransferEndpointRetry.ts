import { isTransientConnectivityError } from '@/sync/runtime/connectivity/transientConnectivityErrors';
import { BoundedResponseBodyError } from '@/utils/system/readBoundedResponseBody';
import { MACHINE_RPC_TIMEOUT_ERROR_CODE } from '@happier-dev/protocol/rpcErrors';

const RETRYABLE_DIRECT_TRANSFER_HTTP_STATUSES = new Set([408, 500, 502, 503, 504]);

export class DirectTransferHttpStatusError extends Error {
    readonly status: number;

    constructor(status: number) {
        super(`Direct export request failed with status ${status}`);
        this.name = 'DirectTransferHttpStatusError';
        this.status = status;
    }
}

export class DirectTransferRequestTimeoutError extends Error {
    readonly code = MACHINE_RPC_TIMEOUT_ERROR_CODE;
    readonly errorCode = MACHINE_RPC_TIMEOUT_ERROR_CODE;

    constructor(cause?: unknown) {
        super('Direct transfer request timed out', { cause });
        this.name = 'DirectTransferRequestTimeoutError';
    }
}

/** The sole endpoint-candidate retry classifier for direct transfer imports and exports. */
export function isRetryableDirectTransferEndpointError(error: unknown): boolean {
    if (isTransientConnectivityError(error)) {
        return true;
    }
    if (error instanceof DirectTransferHttpStatusError) {
        return RETRYABLE_DIRECT_TRANSFER_HTTP_STATUSES.has(error.status);
    }
    return error instanceof BoundedResponseBodyError && error.code === 'read_failed';
}
