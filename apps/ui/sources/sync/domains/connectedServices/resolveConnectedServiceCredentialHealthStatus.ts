import {
    normalizeConnectedServiceCredentialHealthStatus,
    type ConnectedServiceCredentialHealthStatusV1,
} from '@happier-dev/protocol';

/**
 * Map raw connected-service profile status values onto the canonical credential
 * health enum. Unknown values fail closed to `needs_reauth` so no screen treats
 * unrecognized credential state as healthy.
 */
export function resolveConnectedServiceCredentialHealthStatus(
    raw: unknown,
): ConnectedServiceCredentialHealthStatusV1 {
    return normalizeConnectedServiceCredentialHealthStatus(raw);
}
