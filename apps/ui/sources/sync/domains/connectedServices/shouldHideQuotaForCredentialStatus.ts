import {
    ConnectedServiceCredentialHealthStatusV1Schema,
    isConnectedServiceCredentialHealthStatusReconnectRequired,
} from '@happier-dev/protocol/connect/connected-service-schemas';

/**
 * Usage-DISPLAY gate for a connected-service credential. Returns `true` ONLY for
 * an EXPLICIT, recognized `needs_reauth` status; every other value — `null`,
 * `undefined`, `''`, an unknown/unrecognized string, or a usable status
 * (`connected` / `refreshing` / `refresh_failed_retryable`) — returns `false`
 * (SHOW usage, presumed healthy for display).
 *
 * This deliberately FAILS OPEN, the opposite fail-direction from
 * `normalizeConnectedServiceCredentialHealthStatus` (unknown -> `needs_reauth`),
 * which is correct for reauth-PROMPTING but wrong for usage display: an absent
 * or unknown status must not blank a healthy account's capacity avatar.
 *
 * Single owner reused by account usage presentation and the quota hooks'
 * fetch-key derivation so display and reads agree about signed-out usage.
 */
export function shouldHideQuotaForCredentialStatus(status: unknown): boolean {
    const parsed = ConnectedServiceCredentialHealthStatusV1Schema.safeParse(status);
    return parsed.success && isConnectedServiceCredentialHealthStatusReconnectRequired(parsed.data);
}
