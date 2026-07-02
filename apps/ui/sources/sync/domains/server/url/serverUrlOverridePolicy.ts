import { canonicalizeServerUrl, createServerUrlComparableKey } from './serverUrlCanonical';
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
    allowLoopbackOverride?: boolean;
}>): string | null {
    const requested = canonicalizeServerUrl(String(params.requestedServerUrl ?? ''));
    if (!requested) return null;

    const requestedKey = createServerUrlComparableKey(requested);
    if (!requestedKey) return null;

    const active = canonicalizeServerUrl(String(params.activeServerUrl ?? ''));
    if (!active) return requested;

    const activeKey = createServerUrlComparableKey(active);
    if (!activeKey) return requested;

    // Loopback targets are only safe when they resolve to the same active server.
    // This avoids treating a forwarded web origin as if it could reach a different
    // machine-local relay just because both URLs are loopback-shaped.
    if (isLoopbackServerUrl(requested) && requestedKey !== activeKey && params.allowLoopbackOverride !== true) {
        return null;
    }
    return requested;
}

export function shouldSwitchToServerUrl(params: Readonly<{
    targetServerUrl: string | null | undefined;
    activeServerUrl: string | null | undefined;
}>): boolean {
    const target = canonicalizeServerUrl(String(params.targetServerUrl ?? ''));
    if (!target) return false;

    const targetKey = createServerUrlComparableKey(target);
    if (!targetKey) return false;

    const active = canonicalizeServerUrl(String(params.activeServerUrl ?? ''));
    if (!active) return true;

    const activeKey = createServerUrlComparableKey(active);
    if (!activeKey) return true;

    return targetKey !== activeKey;
}
