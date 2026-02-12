export const OAUTH_STATE_UNAVAILABLE_CODE = "oauth_state_unavailable";

export class OAuthStateUnavailableError extends Error {
    readonly code = OAUTH_STATE_UNAVAILABLE_CODE;

    constructor(message = OAUTH_STATE_UNAVAILABLE_CODE) {
        super(message);
        this.name = "OAuthStateUnavailableError";
    }
}

export function isOAuthStateUnavailableError(error: unknown): boolean {
    if (!error || typeof error !== "object") {
        return false;
    }
    if (error instanceof OAuthStateUnavailableError) {
        return true;
    }
    if ("code" in error && (error as { code?: unknown }).code === OAUTH_STATE_UNAVAILABLE_CODE) {
        return true;
    }
    return error instanceof Error && error.message === OAUTH_STATE_UNAVAILABLE_CODE;
}
