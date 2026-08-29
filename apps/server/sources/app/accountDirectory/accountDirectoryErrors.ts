export type AccountDirectoryErrorCode =
    | "invalid_request"
    | "not_found"
    | "preferred_home_not_found"
    | "directory_link_conflict"
    | "invalid_assertion"
    | "assertion_expired"
    | "assertion_wrong_audience"
    | "assertion_client_key_mismatch"
    | "assertion_issuer_untrusted"
    | "rate_limited";

export class AccountDirectoryError extends Error {
    readonly code: AccountDirectoryErrorCode;
    readonly statusCode: number;

    constructor(code: AccountDirectoryErrorCode, message = code, statusCode?: number) {
        super(message);
        this.name = "AccountDirectoryError";
        this.code = code;
        this.statusCode = statusCode ?? ({
            invalid_request: 400,
            not_found: 404,
            preferred_home_not_found: 404,
            directory_link_conflict: 409,
            invalid_assertion: 401,
            assertion_expired: 401,
            assertion_wrong_audience: 401,
            assertion_client_key_mismatch: 401,
            assertion_issuer_untrusted: 401,
            rate_limited: 429,
        } satisfies Record<AccountDirectoryErrorCode, number>)[code];
    }
}
