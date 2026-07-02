import { z } from 'zod';

export const CONNECTED_SERVICE_ERROR_CODES = {
    credentialNotFound: 'connect_credential_not_found',
    credentialInvalid: 'connect_credential_invalid',
    credentialUnsupportedFormat: 'connect_credential_unsupported_format',
    credentialSealUnavailable: 'connect_credential_seal_unavailable',
    oauthStateMismatch: 'connect_oauth_state_mismatch',
    oauthTimeout: 'connect_oauth_timeout',
    oauthExchangeFailed: 'connect_oauth_exchange_failed',
    oauthInvalidGrant: 'connect_oauth_invalid_grant',
    oauthInvalidClient: 'connect_oauth_invalid_client',
    oauthMissingRefreshToken: 'connect_oauth_missing_refresh_token',
    reconnectRequired: 'connect_reconnect_required',
    reconnectProviderIdentityMismatch: 'connect_reconnect_provider_identity_mismatch',
    authGroupNotFound: 'connect_group_not_found',
    authGroupGenerationConflict: 'connect_group_generation_conflict',
} as const;

export const ConnectedServiceErrorCodeSchema = z.enum([
    CONNECTED_SERVICE_ERROR_CODES.credentialNotFound,
    CONNECTED_SERVICE_ERROR_CODES.credentialInvalid,
    CONNECTED_SERVICE_ERROR_CODES.credentialUnsupportedFormat,
    CONNECTED_SERVICE_ERROR_CODES.credentialSealUnavailable,
    CONNECTED_SERVICE_ERROR_CODES.oauthStateMismatch,
    CONNECTED_SERVICE_ERROR_CODES.oauthTimeout,
    CONNECTED_SERVICE_ERROR_CODES.oauthExchangeFailed,
    CONNECTED_SERVICE_ERROR_CODES.oauthInvalidGrant,
    CONNECTED_SERVICE_ERROR_CODES.oauthInvalidClient,
    CONNECTED_SERVICE_ERROR_CODES.oauthMissingRefreshToken,
    CONNECTED_SERVICE_ERROR_CODES.reconnectRequired,
    CONNECTED_SERVICE_ERROR_CODES.reconnectProviderIdentityMismatch,
    CONNECTED_SERVICE_ERROR_CODES.authGroupNotFound,
    CONNECTED_SERVICE_ERROR_CODES.authGroupGenerationConflict,
]);

export type ConnectedServiceErrorCode = z.infer<typeof ConnectedServiceErrorCodeSchema>;
