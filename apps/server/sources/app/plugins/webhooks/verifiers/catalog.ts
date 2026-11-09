import { createHmac, timingSafeEqual } from "node:crypto";

export type PluginWebhookSignedVerifierKindV1 = "github_hmac_sha256_v1" | "sentry_hmac_sha256_v1";

export type PluginWebhookStreamingSignatureVerifierV1 = Readonly<{
    update(chunk: Uint8Array): void;
    verify(signatureHeader: unknown): boolean;
}>;

/**
 * One signed verifier kind: the provider headers the ingress owner reads and
 * the streaming raw-body signature check. Header names are lowercase, as
 * Fastify presents them.
 */
export type PluginWebhookSignedVerifierV1 = Readonly<{
    kind: PluginWebhookSignedVerifierKindV1;
    signatureHeader: string;
    deliveryIdHeader: string;
    eventHeader: "x-github-event" | "sentry-hook-resource";
    createVerifier(secret: string): PluginWebhookStreamingSignatureVerifierV1;
}>;

/**
 * HMAC-SHA256 over the exact raw body, compared in constant time against the
 * hex digest captured by `signaturePattern`. A missing or malformed header is
 * compared against zero bytes so every refusal does the same work.
 */
export function createHmacSha256HexSignatureVerifierV1(
    secret: string,
    signaturePattern: RegExp,
): PluginWebhookStreamingSignatureVerifierV1 {
    const hmac = createHmac("sha256", secret);
    let finalized = false;
    return {
        update(chunk) {
            if (finalized) throw new Error("Webhook signature verifier has already been finalized");
            hmac.update(chunk);
        },
        verify(signatureHeader) {
            if (finalized) return false;
            finalized = true;
            const expected = hmac.digest();
            const match = typeof signatureHeader === "string" ? signaturePattern.exec(signatureHeader) : null;
            const supplied = match ? Buffer.from(match[1]!, "hex") : Buffer.alloc(expected.byteLength);
            return timingSafeEqual(expected, supplied) && match !== null;
        },
    };
}

const GITHUB_SHA256_SIGNATURE_PATTERN = /^sha256=([0-9a-f]{64})$/u;
// Sentry-Hook-Signature is the bare lowercase hex digest keyed by the
// integration Client Secret (docs.sentry.io integration-platform webhooks).
const SENTRY_SHA256_SIGNATURE_PATTERN = /^([0-9a-f]{64})$/u;

const SIGNED_VERIFIERS_V1: Readonly<Record<PluginWebhookSignedVerifierKindV1, PluginWebhookSignedVerifierV1>> = {
    github_hmac_sha256_v1: {
        kind: "github_hmac_sha256_v1",
        signatureHeader: "x-hub-signature-256",
        deliveryIdHeader: "x-github-delivery",
        eventHeader: "x-github-event",
        createVerifier: (secret) => createHmacSha256HexSignatureVerifierV1(secret, GITHUB_SHA256_SIGNATURE_PATTERN),
    },
    sentry_hmac_sha256_v1: {
        kind: "sentry_hmac_sha256_v1",
        signatureHeader: "sentry-hook-signature",
        deliveryIdHeader: "request-id",
        eventHeader: "sentry-hook-resource",
        createVerifier: (secret) => createHmacSha256HexSignatureVerifierV1(secret, SENTRY_SHA256_SIGNATURE_PATTERN),
    },
};

export function isPluginWebhookSignedVerifierKindV1(kind: string): kind is PluginWebhookSignedVerifierKindV1 {
    return Object.hasOwn(SIGNED_VERIFIERS_V1, kind);
}

/** Sole lookup for signed verifier kinds; capability URLs and unknown kinds have none. */
export function readPluginWebhookSignedVerifierV1(kind: string): PluginWebhookSignedVerifierV1 | null {
    return isPluginWebhookSignedVerifierKindV1(kind) ? SIGNED_VERIFIERS_V1[kind] : null;
}
