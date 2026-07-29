import { isTerminalAuthError } from './authErrors';

export function isTransientConnectivityError(error: unknown): boolean {
    if (isTerminalAuthError(error)) {
        return false;
    }
    if (!(error instanceof Error)) {
        return false;
    }
    if (
        error.name === 'ServerFetchConnectivityTimeoutError'
        || error.name === 'ServerFetchAbortedForServerSwitchError'
        || error.name === 'ServerFetchWriteTimeoutError'
    ) {
        return true;
    }
    const message = error.message.trim().toLowerCase();
    return message === 'failed to fetch'
        || message === 'socket connect timeout'
        || message.includes('connect_error');
}
