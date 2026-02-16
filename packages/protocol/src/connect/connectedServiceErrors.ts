import { z } from 'zod';

export const CONNECTED_SERVICE_ERROR_CODES = {
    credentialNotFound: 'connect_credential_not_found',
    credentialInvalid: 'connect_credential_invalid',
    credentialUnsupportedFormat: 'connect_credential_unsupported_format',
    credentialSealUnavailable: 'connect_credential_seal_unavailable',
    oauthStateMismatch: 'connect_oauth_state_mismatch',
    oauthTimeout: 'connect_oauth_timeout',
    oauthExchangeFailed: 'connect_oauth_exchange_failed',
} as const;

export const ConnectedServiceErrorCodeSchema = z.enum([
    CONNECTED_SERVICE_ERROR_CODES.credentialNotFound,
    CONNECTED_SERVICE_ERROR_CODES.credentialInvalid,
    CONNECTED_SERVICE_ERROR_CODES.credentialUnsupportedFormat,
    CONNECTED_SERVICE_ERROR_CODES.credentialSealUnavailable,
    CONNECTED_SERVICE_ERROR_CODES.oauthStateMismatch,
    CONNECTED_SERVICE_ERROR_CODES.oauthTimeout,
    CONNECTED_SERVICE_ERROR_CODES.oauthExchangeFailed,
]);

export type ConnectedServiceErrorCode = z.infer<typeof ConnectedServiceErrorCodeSchema>;
