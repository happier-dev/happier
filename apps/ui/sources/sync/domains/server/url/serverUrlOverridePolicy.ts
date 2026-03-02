import { canonicalizeServerUrl } from './serverUrlCanonical';
import { isLoopbackServerUrl } from './serverUrlClassification';

/**
 * Cross-device QR/deep-link policy:
 * - If a link tries to override the server to a loopback-only URL (localhost/127.0.0.1/etc),
 *   ignore that override when we already have a non-loopback active server.
 *
 * This prevents mobile devices from being "switched" to an unreachable `localhost` server
 * after scanning a QR code produced on a different machine.
 */
export function resolveEffectiveServerUrlOverride(params: Readonly<{
    requestedServerUrl: string | null | undefined;
    activeServerUrl: string | null | undefined;
}>): string | null {
    const requested = canonicalizeServerUrl(String(params.requestedServerUrl ?? ''));
    if (!requested) return null;

    const active = canonicalizeServerUrl(String(params.activeServerUrl ?? ''));
    if (requested && isLoopbackServerUrl(requested) && active && !isLoopbackServerUrl(active)) {
        return null;
    }
    return requested;
}

