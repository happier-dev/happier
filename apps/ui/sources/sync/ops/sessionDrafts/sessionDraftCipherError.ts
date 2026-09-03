export class SessionDraftContextUnavailableError extends Error {
    readonly code = 'session_context_unavailable' as const;

    constructor() {
        super('Session draft encryption context is unavailable');
        this.name = 'SessionDraftContextUnavailableError';
    }
}

export function isSessionDraftContextUnavailableError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    return 'code' in error && error.code === 'session_context_unavailable';
}
