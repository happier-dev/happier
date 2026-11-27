import { createHmac, timingSafeEqual } from "node:crypto";

import * as privacyKit from "privacy-kit";

/**
 * Verifies a Standard Webhooks signature (Polar secrets created on or after 2026-09-08 use the
 * standard as-is): HMAC-SHA256 over `{webhook-id}.{webhook-timestamp}.{raw body}`, keyed by the
 * base64-decoded secret (an optional `whsec_` prefix is not part of the key). The header lists
 * one or more space-separated `v1,<base64>` signatures; any match passes.
 *
 * No timestamp window: every delivery is re-read from Polar, so a replay converges to the same
 * state and writes nothing.
 */
export function verifyPolarWebhookSignature(params: Readonly<{
    secret: string;
    rawBody: string;
    webhookId: string | undefined;
    webhookTimestamp: string | undefined;
    webhookSignature: string | undefined;
}>): boolean {
    const { webhookId, webhookTimestamp, webhookSignature } = params;
    if (!webhookId || !webhookTimestamp || !webhookSignature) return false;
    let key: Uint8Array;
    try {
        key = privacyKit.decodeBase64(params.secret.startsWith("whsec_") ? params.secret.slice("whsec_".length) : params.secret);
    } catch {
        return false;
    }
    if (key.length === 0) return false;
    const expected = createHmac("sha256", key).update(`${webhookId}.${webhookTimestamp}.${params.rawBody}`).digest();
    for (const entry of webhookSignature.split(" ")) {
        const [version, signature] = entry.split(",", 2);
        if (version !== "v1" || !signature) continue;
        let candidate: Uint8Array;
        try {
            candidate = privacyKit.decodeBase64(signature);
        } catch {
            continue;
        }
        if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return true;
    }
    return false;
}
