export const CREATED_SESSION_NOT_AVAILABLE_LOCALLY_ERROR = 'Created session is not available locally yet';
export const CREATED_SESSION_NOT_ACTIVE_LOCALLY_ERROR = 'Created session is not active locally yet';

const CREATED_SESSION_LOCAL_READINESS_ERROR_MESSAGES = new Set<string>([
    CREATED_SESSION_NOT_AVAILABLE_LOCALLY_ERROR,
    CREATED_SESSION_NOT_ACTIVE_LOCALLY_ERROR,
]);

export function isCreatedSessionLocalReadinessErrorMessage(message: string): boolean {
    return CREATED_SESSION_LOCAL_READINESS_ERROR_MESSAGES.has(message);
}
