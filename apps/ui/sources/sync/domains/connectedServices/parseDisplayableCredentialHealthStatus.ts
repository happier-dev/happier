import {
    ConnectedServiceCredentialHealthStatusV1Schema,
    type ConnectedServiceCredentialHealthStatusV1,
} from '@happier-dev/protocol';

/**
 * DISPLAY parse for a connected-service credential status. Returns the status
 * only when it is an EXPLICIT, recognized value; `null`, `undefined`, `''` and
 * any unrecognized string all become `null` — no pill, no health claim, no
 * hidden usage.
 *
 * This deliberately FAILS OPEN, the opposite fail-direction from
 * `normalizeConnectedServiceCredentialHealthStatus` (unknown -> `needs_reauth`).
 * The fail-CLOSED normalizer is correct for reauth-PROMPTING actions and
 * ordering, and wrong for display: an absent or unknown status must not paint a
 * healthy account as broken.
 *
 * Single owner for every account surface (legacy block, qualified block,
 * qualified detail) so they can never disagree about what an unknown status
 * means on screen.
 */
export function parseDisplayableCredentialHealthStatus(
    status: unknown,
): ConnectedServiceCredentialHealthStatusV1 | null {
    const parsed = ConnectedServiceCredentialHealthStatusV1Schema.safeParse(status);
    return parsed.success ? parsed.data : null;
}
