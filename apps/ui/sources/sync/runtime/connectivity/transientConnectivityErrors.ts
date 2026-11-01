import { isTerminalAuthError } from './authErrors';

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
    if (
        error.name === 'ServerFetchConnectivityTimeoutError'
        || error.name === 'ServerFetchAbortedForServerSwitchError'
        || error.name === 'ServerFetchWriteTimeoutError'
        || error.name === 'ServerFetchReadTimeoutError'
        || error.name === 'ServerFetchReadSupersededError'
    ) {
        return true;
    }
    const message = error.message.trim().toLowerCase();
    return message === 'failed to fetch'
        || message === 'socket connect timeout'
        || message.includes('connect_error');
}
