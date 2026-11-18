import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { PluginWebhookVerifierV1 } from '@happier-dev/protocol/plugins/contributions/webhooks';

export type PluginWebhookSignedVerifierKindV1 = Exclude<PluginWebhookVerifierV1['kind'], 'capabilityUrl_v1'>;

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
    eventHeader: "x-github-event" | "sentry-hook-resource" | "x-gitlab-event" | "x-event-key";
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

const PREFIXED_SHA256_SIGNATURE_PATTERN = /^sha256=([0-9a-f]{64})$/u;
// Sentry-Hook-Signature is the bare lowercase hex digest keyed by the
// integration Client Secret (docs.sentry.io integration-platform webhooks).
const SENTRY_SHA256_SIGNATURE_PATTERN = /^([0-9a-f]{64})$/u;

/** GitLab sends the secret token verbatim; fixed-size digests avoid a length-dependent comparison. */
function createGitlabTokenVerifierV1(secret: string): PluginWebhookStreamingSignatureVerifierV1 {
    const expected = createHash('sha256').update(secret, 'utf8').digest();
    let finalized = false;
    return {
        update() {
            if (finalized) throw new Error('Webhook signature verifier has already been finalized');
        },
        verify(header) {
            if (finalized) return false;
            finalized = true;
            const valid = typeof header === 'string' && header.length > 0 && !/[\r\n\0]/u.test(header);
            const supplied = createHash('sha256').update(valid ? header : '', 'utf8').digest();
            return timingSafeEqual(expected, supplied) && valid && secret.length > 0;
        },
    };
}

const SIGNED_VERIFIERS_V1: Readonly<Record<PluginWebhookSignedVerifierKindV1, PluginWebhookSignedVerifierV1>> = {
    github_hmac_sha256_v1: {
        kind: "github_hmac_sha256_v1",
        signatureHeader: "x-hub-signature-256",
        deliveryIdHeader: "x-github-delivery",
        eventHeader: "x-github-event",
        createVerifier: (secret) => createHmacSha256HexSignatureVerifierV1(secret, PREFIXED_SHA256_SIGNATURE_PATTERN),
    },
    sentry_hmac_sha256_v1: {
        kind: "sentry_hmac_sha256_v1",
        signatureHeader: "sentry-hook-signature",
        deliveryIdHeader: "request-id",
        eventHeader: "sentry-hook-resource",
        createVerifier: (secret) => createHmacSha256HexSignatureVerifierV1(secret, SENTRY_SHA256_SIGNATURE_PATTERN),
    },
    gitlab_token_v1: {
        kind: 'gitlab_token_v1',
        signatureHeader: 'x-gitlab-token',
        deliveryIdHeader: 'x-gitlab-webhook-uuid',
        eventHeader: 'x-gitlab-event',
        createVerifier: createGitlabTokenVerifierV1,
    },
    bitbucket_hmac_sha256_v1: {
        kind: 'bitbucket_hmac_sha256_v1',
        signatureHeader: 'x-hub-signature',
        deliveryIdHeader: 'x-request-uuid',
        eventHeader: 'x-event-key',
        createVerifier: (secret) => createHmacSha256HexSignatureVerifierV1(secret, PREFIXED_SHA256_SIGNATURE_PATTERN),
    },
};

export function isPluginWebhookSignedVerifierKindV1(kind: string): kind is PluginWebhookSignedVerifierKindV1 {
    return Object.hasOwn(SIGNED_VERIFIERS_V1, kind);
}

/** Sole lookup for signed verifier kinds; capability URLs and unknown kinds have none. */
export function readPluginWebhookSignedVerifierV1(kind: string): PluginWebhookSignedVerifierV1 | null {
    return isPluginWebhookSignedVerifierKindV1(kind) ? SIGNED_VERIFIERS_V1[kind] : null;
}
