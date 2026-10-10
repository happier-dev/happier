import { isTerminalAuthError } from './authErrors';
import { HappyError } from '@/utils/errors/errors';

export class RetryableServerResponseError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = 'RetryableServerResponseError';
        this.status = status;
    }
}

export function isTransientConnectivityError(error: unknown): boolean {
    if (isTerminalAuthError(error)) {
        return false;
    }
    if (!(error instanceof Error)) {
        return false;
    }
    if (error instanceof RetryableServerResponseError) {
        return true;
    }
    if ('kind' in error && error.kind === 'network' && (!('code' in error) || error.code !== 'endpoint_offline')) {
        return true;
    }
    if (
        error.name === 'ServerFetchAbortedForServerSwitchError'
        || error.name === 'ServerFetchWriteTimeoutError'
        || error.name === 'DirectTransferRequestTimeoutError'
    ) {
        return true;
    }
    const message = error.message.trim().toLowerCase();
    return message === 'failed to fetch'
        || (error instanceof TypeError && message === 'network request failed')
        || message === 'socket connect timeout'
        || message.includes('connect_error');
}

export function isExplicitlyRetryableError(error: unknown): boolean {
    if (isTerminalAuthError(error)) return false;
    return isTransientConnectivityError(error)
        || (error instanceof HappyError && error.canTryAgain && error.code !== 'endpoint_offline');
}

export function shouldRetryError(error: unknown): boolean {
    if (isTerminalAuthError(error)) return false;
    if (error && typeof error === 'object') {
        const candidate = error as { code?: unknown; retryable?: unknown; canTryAgain?: unknown };
        if (candidate.code === 'endpoint_offline') return false;
        if (isTransientConnectivityError(error)) return true;
        if (candidate.retryable === false || candidate.canTryAgain === false) return false;
    }
    return true;
}
