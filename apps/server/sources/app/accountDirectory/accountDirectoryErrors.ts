import { ACCOUNT_DIRECTORY_ERROR_CODES_V1, type AccountDirectoryErrorCodeV1 } from '@happier-dev/protocol/auth/accountDirectory';
import type { FastifyError, FastifyReply } from "fastify";
import { InactiveAccountError } from "@/app/auth/accountStatus";

export type AccountDirectoryErrorCode =
    | "invalid_request"
    | "not_found"
    | "preferred_home_not_found"
    | "directory_link_conflict"
    | "descriptor_revision_conflict"
    | "label_mode_mismatch"
    | "invalid_assertion"
    | "assertion_expired"
    | "assertion_clock_skew"
    | "assertion_wrong_audience"
    | "credential_destination_mismatch"
    | "invalid_client_key"
    | "assertion_issuer_untrusted"
    | "directory_link_not_found"
    | "invalid_subject"
    | "home_redemption_unavailable"
    | "home_unavailable"
    | "account_disabled"
    | "approval_rejected"
    | "approval_expired"
    | "approval_invalid";

const STATUS_BY_CODE = {
    invalid_request: 400,
    not_found: 404,
    preferred_home_not_found: 404,
    directory_link_conflict: 409,
    descriptor_revision_conflict: 409,
    label_mode_mismatch: 409,
    invalid_assertion: 401,
    assertion_expired: 401,
    assertion_clock_skew: 401,
    assertion_wrong_audience: 401,
    credential_destination_mismatch: 401,
    invalid_client_key: 401,
    assertion_issuer_untrusted: 401,
    directory_link_not_found: 401,
    invalid_subject: 401,
    home_redemption_unavailable: 503,
    home_unavailable: 401,
    account_disabled: 403,
    approval_rejected: 401,
    approval_expired: 401,
    approval_invalid: 401,
} as const satisfies Record<AccountDirectoryErrorCode, number>;

export class AccountDirectoryError extends Error {
    readonly code: AccountDirectoryErrorCode;
    readonly statusCode: number;

    constructor(code: AccountDirectoryErrorCode, message: string = code, statusCode?: number) {
        super(message);
        this.name = "AccountDirectoryError";
        this.code = code;
        this.statusCode = statusCode ?? STATUS_BY_CODE[code];
    }
}

export function accountDirectoryAuthErrorHandler(error: FastifyError, _request: unknown, reply: FastifyReply): void {
    if (error instanceof InactiveAccountError) {
        reply.code(403).send({ error: "account-disabled" });
        return;
    }
    if (!(error instanceof AccountDirectoryError)) throw error;
    const mapped = accountDirectoryProtocolErrorResponse(error);
    if (!mapped) throw error;
    reply.code(mapped.statusCode).send(mapped.body);
}

/**
 * The one internal→protocol error mapping for every Account Directory route.
 * It is total over `AccountDirectoryErrorCode`, so responses always carry a
 * protocol-owned strict error code and arbitrary strings can never reach the
 * wire. Per-route transports stay free to adjust only the status code.
 */
export const ACCOUNT_DIRECTORY_PROTOCOL_ERROR_BY_CODE: Readonly<
    Record<AccountDirectoryErrorCode, AccountDirectoryErrorCodeV1>
> = {
    invalid_request: ACCOUNT_DIRECTORY_ERROR_CODES_V1.invalidRequest,
    not_found: ACCOUNT_DIRECTORY_ERROR_CODES_V1.directoryUnavailable,
    preferred_home_not_found: ACCOUNT_DIRECTORY_ERROR_CODES_V1.directoryUnavailable,
    directory_link_conflict: ACCOUNT_DIRECTORY_ERROR_CODES_V1.invalidRequest,
    descriptor_revision_conflict: ACCOUNT_DIRECTORY_ERROR_CODES_V1.descriptorRevisionConflict,
    label_mode_mismatch: ACCOUNT_DIRECTORY_ERROR_CODES_V1.labelModeMismatch,
    invalid_assertion: ACCOUNT_DIRECTORY_ERROR_CODES_V1.invalidAssertionSignature,
    assertion_expired: ACCOUNT_DIRECTORY_ERROR_CODES_V1.assertionExpired,
    assertion_clock_skew: ACCOUNT_DIRECTORY_ERROR_CODES_V1.assertionClockSkew,
    assertion_wrong_audience: ACCOUNT_DIRECTORY_ERROR_CODES_V1.invalidAudience,
    credential_destination_mismatch: ACCOUNT_DIRECTORY_ERROR_CODES_V1.invalidAudience,
    invalid_client_key: ACCOUNT_DIRECTORY_ERROR_CODES_V1.invalidClientKey,
    assertion_issuer_untrusted: ACCOUNT_DIRECTORY_ERROR_CODES_V1.invalidIssuer,
    directory_link_not_found: ACCOUNT_DIRECTORY_ERROR_CODES_V1.directoryLinkNotFound,
    invalid_subject: ACCOUNT_DIRECTORY_ERROR_CODES_V1.invalidSubject,
    home_redemption_unavailable: ACCOUNT_DIRECTORY_ERROR_CODES_V1.homeUnavailable,
    home_unavailable: ACCOUNT_DIRECTORY_ERROR_CODES_V1.homeUnavailable,
    account_disabled: ACCOUNT_DIRECTORY_ERROR_CODES_V1.accountDisabled,
    approval_rejected: ACCOUNT_DIRECTORY_ERROR_CODES_V1.approvalRejected,
    approval_expired: ACCOUNT_DIRECTORY_ERROR_CODES_V1.approvalExpired,
    approval_invalid: ACCOUNT_DIRECTORY_ERROR_CODES_V1.approvalInvalid,
};

/**
 * Projects domain errors and the two native Fastify boundary failures owned by
 * this route family onto its strict protocol response. Everything else stays
 * with the server's existing global error handler.
 */
export function accountDirectoryProtocolErrorResponse(error: unknown): Readonly<{
    statusCode: number;
    body: Readonly<{ error: AccountDirectoryErrorCodeV1 }>;
}> | null {
    if (error instanceof AccountDirectoryError) {
        return {
            statusCode: error.statusCode,
            body: { error: ACCOUNT_DIRECTORY_PROTOCOL_ERROR_BY_CODE[error.code] },
        };
    }

    const fastifyError = error as Readonly<{ statusCode?: unknown; validation?: unknown }>;
    if (Array.isArray(fastifyError?.validation) || fastifyError?.statusCode === 400) {
        return {
            statusCode: 400,
            body: { error: ACCOUNT_DIRECTORY_ERROR_CODES_V1.invalidRequest },
        };
    }
    if (fastifyError?.statusCode === 429) {
        return {
            statusCode: 429,
            body: { error: ACCOUNT_DIRECTORY_ERROR_CODES_V1.rateLimited },
        };
    }
    return null;
}
