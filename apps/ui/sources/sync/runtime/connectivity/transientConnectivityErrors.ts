import { isTerminalAuthError } from './authErrors';
import { HappyError } from '@/utils/errors/errors';

export const SERVER_UNREACHABLE_ERROR_CODE = 'server_unreachable';

export function isBrowserOffline(): boolean {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function isFetchTransportFailure(error: Error, message = error.message.trim().toLowerCase()): boolean {
    return message === 'failed to fetch' || (error instanceof TypeError && message === 'network request failed');
}

export function readServerUnreachableFetchCode(error: unknown): typeof SERVER_UNREACHABLE_ERROR_CODE | null {
    return (error instanceof Error && isFetchTransportFailure(error))
        || (error instanceof HappyError && error.kind === 'network' && error.code === 'endpoint_offline')
        ? SERVER_UNREACHABLE_ERROR_CODE : null;
}

/** Expo's production web loader reports script failure without an HTTP status. */
export function readServerUnreachableModuleLoadCode(error: unknown): typeof SERVER_UNREACHABLE_ERROR_CODE | null {
    if (!(error instanceof Error)) return null;
    for (const candidate of [error, error.cause]) {
        if (readServerUnreachableFetchCode(candidate)) return SERVER_UNREACHABLE_ERROR_CODE;
        if (candidate instanceof Error && candidate.name === 'AsyncRequireError'
            && 'type' in candidate && candidate.type === 'error' && isBrowserOffline()) {
            return SERVER_UNREACHABLE_ERROR_CODE;
        }
    }
    return null;
}

export class RetryableServerResponseError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = 'RetryableServerResponseError';
        this.status = status;
    }
}

/** A server answer to a request that must not be re-sent: it may already have taken effect. */
export class NonRetryableServerResponseError extends Error {
    readonly status: number;
    readonly retryable = false;

    constructor(status: number, message: string) {
        super(message);
        this.name = 'NonRetryableServerResponseError';
        this.status = status;
    }
}

/** Manual recovery is control flow, not a failed network attempt. */
export function isServerFetchReadSupersededError(error: unknown): boolean {
    return error instanceof Error && error.name === 'ServerFetchReadSupersededError';
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
        || error.name === 'ServerFetchReadTimeoutError'
        || error.name === 'DirectTransferRequestTimeoutError'
    ) {
        return true;
    }
    const message = error.message.trim().toLowerCase();
    return isFetchTransportFailure(error, message)
        || message === 'socket connect timeout'
        || message.includes('connect_error');
}

export function isExplicitlyRetryableError(error: unknown): boolean {
    if (isTerminalAuthError(error)) return false;
    return isTransientConnectivityError(error)
        || (error instanceof HappyError && error.canTryAgain && error.code !== 'endpoint_offline');
}

export function shouldRetryError(error: unknown): boolean {
    if (isServerFetchReadSupersededError(error)) return false;
    if (isTerminalAuthError(error)) return false;
    if (error && typeof error === 'object') {
        const candidate = error as { code?: unknown; retryable?: unknown; canTryAgain?: unknown };
        if (candidate.code === 'endpoint_offline') return false;
        if (isTransientConnectivityError(error)) return true;
        if (candidate.retryable === false || candidate.canTryAgain === false) return false;
    }
    return true;
}
