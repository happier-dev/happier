import { HappyError } from '@/utils/errors/errors';

export function createNotAuthenticatedError(status?: 401 | 403): HappyError {
    return new HappyError('Authentication required', false, {
        status,
        kind: 'auth',
        code: 'not_authenticated',
    });
}

export function isAuthenticationResponseStatus(status: unknown): status is 401 | 403 {
    return status === 401 || status === 403;
}

export function isTerminalAuthError(error: unknown): boolean {
    if (error instanceof HappyError) {
        return error.kind === 'auth' && (error.canTryAgain === false || error.code === 'not_authenticated');
    }
    if (!error || typeof error !== 'object') {
        return false;
    }
    const candidate = error as {
        canTryAgain?: unknown;
        code?: unknown;
        kind?: unknown;
    };
    return (
        candidate.kind === 'auth'
        && (candidate.canTryAgain === false || candidate.code === 'not_authenticated')
    );
}
