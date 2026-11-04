import type { ConnectedServiceCredentialRefreshFailureKindV1 } from '@happier-dev/protocol/connect/connected-service-schemas';

/** Preserve the existing authentication classification for callers needing only the kind. */
export function classifyConnectedAccountTokenEndpointFailure(response: Readonly<{
    status: number;
    body: Uint8Array;
}>): ConnectedServiceCredentialRefreshFailureKindV1 {
    return parseConnectedAccountTokenEndpointFailure(response).kind;
}

/** Only these fixed OAuth codes may leave the response boundary; never retain descriptions or bodies. */
const diagnosticOAuthCodes = [
    'invalid_grant', 'refresh_token_reused', 'refresh_token_expired',
    'refresh_token_invalidated', 'invalid_client', 'unauthorized_client',
] as const;

export function parseConnectedAccountTokenEndpointFailure(response: Readonly<{
    status: number;
    body: Uint8Array;
}>): Readonly<{
    kind: ConnectedServiceCredentialRefreshFailureKindV1;
    providerErrorCode?: typeof diagnosticOAuthCodes[number];
}> {
    let errorCode: unknown;
    try {
        const body: unknown = JSON.parse(new TextDecoder().decode(response.body));
        if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
            const error = (body as Record<string, unknown>).error;
            errorCode = error !== null && typeof error === 'object' && !Array.isArray(error)
                ? (error as Record<string, unknown>).code : error;
        }
    } catch {
        // A non-JSON error response can still establish an HTTP rejection.
    }
    const providerErrorCode = diagnosticOAuthCodes.find(code => code === errorCode);
    let kind: ConnectedServiceCredentialRefreshFailureKindV1;
    if (errorCode === 'invalid_grant' || errorCode === 'invalid_client') kind = errorCode;
    else if (errorCode === 'refresh_token_reused' || errorCode === 'refresh_token_expired'
        || errorCode === 'refresh_token_invalidated') kind = 'invalid_grant';
    else if (response.status === 401) kind = 'provider_401';
    else if (response.status === 403) kind = 'provider_403';
    else kind = 'unknown';
    return { kind, ...(providerErrorCode === undefined ? {} : { providerErrorCode }) };
}
