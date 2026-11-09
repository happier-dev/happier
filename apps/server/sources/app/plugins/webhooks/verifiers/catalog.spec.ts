import { describe, expect, it } from 'vitest';

import { readPluginWebhookSignedVerifierV1 } from './catalog';

// Sentry integration-platform webhooks: `Sentry-Hook-Signature` is the
// lowercase HMAC-SHA256 hex digest of the exact request body bytes, keyed by
// the integration's Client Secret (docs.sentry.io, read 2026-10-30). The
// golden digest below was computed independently with `openssl dgst -hmac`.
const SENTRY_BODY = new TextEncoder().encode(
  '{"action":"assigned","installation":{"uuid":"7a485448-a9e2-4c85-8a3c-4f44175783c9"},"data":{"issue":{"id":"1170820242","status":"unresolved"}},"actor":{"type":"user","id":1,"name":"Ana"}}',
);
const SENTRY_SECRET = 'sentry-client-secret-fixture';
const SENTRY_SIGNATURE =
  '381d8ad84b90917ee20e3e6526f491dfda2b77532935d461ddb0b8c9ea471c6a';

function verifySentry(params: {
  rawBody?: Uint8Array;
  secret?: string;
  signatureHeader: unknown;
}): boolean {
  const entry = readPluginWebhookSignedVerifierV1('sentry_hmac_sha256_v1');
  if (!entry)
    throw new Error('expected the Sentry verifier kind in the catalog');
  const verifier = entry.createVerifier(params.secret ?? SENTRY_SECRET);
  verifier.update(params.rawBody ?? SENTRY_BODY);
  return verifier.verify(params.signatureHeader);
}

describe('plugin webhook signed verifier catalog', () => {
  it("names Sentry's documented headers and accepts a Sentry-signed body", () => {
    expect(
      readPluginWebhookSignedVerifierV1('sentry_hmac_sha256_v1'),
    ).toMatchObject({
      signatureHeader: 'sentry-hook-signature',
      deliveryIdHeader: 'request-id',
      eventHeader: 'sentry-hook-resource',
    });
    expect(verifySentry({ signatureHeader: SENTRY_SIGNATURE })).toBe(true);
  });

  it('refuses a tampered body, a wrong secret, and missing or malformed signatures without throwing', () => {
    const tampered = SENTRY_BODY.slice();
    tampered[tampered.length - 2] ^= 1;
    expect(
      verifySentry({ rawBody: tampered, signatureHeader: SENTRY_SIGNATURE }),
    ).toBe(false);
    expect(
      verifySentry({
        secret: 'another-integration-secret',
        signatureHeader: SENTRY_SIGNATURE,
      }),
    ).toBe(false);
    for (const signatureHeader of [
      undefined,
      '',
      `sha256=${SENTRY_SIGNATURE}`,
      SENTRY_SIGNATURE.toUpperCase(),
      SENTRY_SIGNATURE.slice(2),
      `${SENTRY_SIGNATURE}00`,
      [SENTRY_SIGNATURE],
    ]) {
      expect(() => verifySentry({ signatureHeader })).not.toThrow();
      expect(verifySentry({ signatureHeader })).toBe(false);
    }
  });

  it("keeps GitHub's verifier on its own headers (signature vectors: githubHmacSha256.spec.ts)", () => {
    expect(readPluginWebhookSignedVerifierV1('github_hmac_sha256_v1')).toMatchObject({
      signatureHeader: 'x-hub-signature-256',
      deliveryIdHeader: 'x-github-delivery',
      eventHeader: 'x-github-event',
    });
  });

  it('has no signed verifier for capability URLs or unknown kinds', () => {
    expect(readPluginWebhookSignedVerifierV1('capabilityUrl_v1')).toBeNull();
    expect(readPluginWebhookSignedVerifierV1('sentry_hmac_sha1_v0')).toBeNull();
  });
});
