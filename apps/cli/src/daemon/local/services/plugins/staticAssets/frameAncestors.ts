import { randomBytes } from 'node:crypto';

import { constantTimeEqualUtf8 } from '@/daemon/privateBearerFile';

/**
 * Who may embed a served hosted-web asset, and how the daemon knows (§3.12, EU-8).
 *
 * The static-asset server binds loopback with an ephemeral port, and the browser
 * sends the daemon **nothing** it could use to identify the embedder: an iframe
 * navigation carries no `Origin`, and the host deliberately sets
 * `referrer-policy: no-referrer`. So the ancestor cannot be derived from the
 * request, and it cannot be taken from the query on trust either — any local
 * page that finds the port could then declare itself the host, which is the
 * "authors cannot forge the host ancestor" clause failing in the other
 * direction.
 *
 * The binding is therefore a capability the daemon ISSUES: one random token per
 * server instance, delivered to the app inside the preview access URL it already
 * mints (`initialPath.search`). Only a client that received that URL through the
 * authenticated preview snapshot can present the token, so `happierHostOrigin`
 * is honoured exactly when it arrives with the daemon's own token. Without it —
 * or with an origin that is not exact — the response keeps refusing every
 * ancestor.
 *
 * Known and accepted bound: the guest document can read its own `location`, so a
 * plugin can learn the token for ITS OWN asset. That lets it declare an ancestor
 * for bytes it already owns and controls; it grants no reach into the host.
 */
export function createHostedWebFrameAncestorToken(): string {
    return randomBytes(16).toString('hex');
}

export const HOSTED_WEB_FRAME_ANCESTOR_TOKEN_QUERY_KEY = 'happierAncestorToken';
export const HOSTED_WEB_FRAME_ANCESTOR_ORIGIN_QUERY_KEY = 'happierHostOrigin';

/**
 * The exact host origins this request may name as embedders. Zero or one today:
 * a single document has a single immediate embedder, and the host declares the
 * one it is.
 */
export function resolveHostedWebFrameAncestors(input: Readonly<{
    expectedToken: string;
    requestUrl: string;
}>): readonly string[] {
    let query: URLSearchParams;
    try {
        query = new URL(input.requestUrl, 'http://127.0.0.1').searchParams;
    } catch {
        return Object.freeze([]);
    }
    const token = query.get(HOSTED_WEB_FRAME_ANCESTOR_TOKEN_QUERY_KEY)?.trim() ?? '';
    const origin = query.get(HOSTED_WEB_FRAME_ANCESTOR_ORIGIN_QUERY_KEY)?.trim() ?? '';
    if (token.length === 0 || origin.length === 0 || !constantTimeEqualUtf8(input.expectedToken, token)) {
        return Object.freeze([]);
    }
    // Exactness itself is the Protocol CSP owner's rule; passing the candidate
    // through keeps ONE definition of "an exact origin" rather than a second
    // parser here that could disagree with the directive builder.
    return Object.freeze([origin]);
}
