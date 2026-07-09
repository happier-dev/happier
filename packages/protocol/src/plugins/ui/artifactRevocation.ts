import { z } from 'zod';
import tweetnacl from 'tweetnacl';

import { decodeBase64 } from '../../crypto/base64.js';
import { createCanonicalJsonSigningInput } from '../../machines/peer/mediation/directRouteGrantV1.js';
import { PluginUiArtifactDigestV1Schema } from './artifactIntegrity.js';
import { PluginUiArtifactTrustRootV1Schema, type PluginUiArtifactTrustRootV1 } from './artifactTrust.js';

export const PluginUiArtifactRevocationScopeV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('plugin'),
    pluginId: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal('contribution'),
    pluginId: z.string().trim().min(1),
    contributionId: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal('digest'),
    digest: PluginUiArtifactDigestV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('signingKey'),
    signingKeyId: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal('trustRoot'),
    trustRootId: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal('installSource'),
    sourceId: z.string().trim().min(1),
  }).strict(),
]);
export type PluginUiArtifactRevocationScopeV1 =
  z.infer<typeof PluginUiArtifactRevocationScopeV1Schema>;

export const PluginUiArtifactRevocationV1Schema = z.object({
  id: z.string().trim().min(1),
  scope: PluginUiArtifactRevocationScopeV1Schema,
  reason: z.enum(['compromised', 'incompatible', 'policy_denied', 'user_disabled', 'unknown']),
  revokedAt: z.string().datetime(),
}).strict();
export type PluginUiArtifactRevocationV1 =
  z.infer<typeof PluginUiArtifactRevocationV1Schema>;

const Base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/u);

export const PluginUiArtifactRevocationFeedBodyV1Schema = z.object({
  t: z.literal('happier.pluginUi.artifactRevocationFeed.body.v1'),
  schemaVersion: z.literal(1),
  generation: z.number().int().nonnegative(),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
  revocations: z.array(PluginUiArtifactRevocationV1Schema),
}).strict().superRefine((body, ctx) => {
  if (body.expiresAt && Date.parse(body.expiresAt) <= Date.parse(body.issuedAt)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expiresAt'],
      message: 'revocation feed expiry must be after issuance',
    });
  }
});
export type PluginUiArtifactRevocationFeedBodyV1 =
  z.infer<typeof PluginUiArtifactRevocationFeedBodyV1Schema>;

export const PluginUiArtifactRevocationFeedEnvelopeV1Schema = z.object({
  t: z.literal('happier.pluginUi.artifactRevocationFeed.v1'),
  alg: z.literal('ed25519'),
  keyId: z.string().trim().min(1),
  trustRootId: z.string().trim().min(1),
  body: PluginUiArtifactRevocationFeedBodyV1Schema,
  signature: Base64UrlSchema,
}).strict();
export type PluginUiArtifactRevocationFeedEnvelopeV1 =
  z.infer<typeof PluginUiArtifactRevocationFeedEnvelopeV1Schema>;

export type VerifyPluginUiArtifactRevocationFeedV1Result =
  | Readonly<{ valid: true; body: PluginUiArtifactRevocationFeedBodyV1 }>
  | Readonly<{
      valid: false;
      reasonCode:
        | 'revocation_feed_invalid'
        | 'trust_root_missing'
        | 'signing_key_missing'
        | 'invalid_public_key'
        | 'invalid_signature'
        | 'bad_signature'
        | 'stale_generation';
    }>;

function decodeBase64UrlStrict(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) return null;
  try {
    return decodeBase64(value, 'base64url');
  } catch {
    return null;
  }
}

function normalizeRevocations(
  revocations: readonly PluginUiArtifactRevocationV1[],
): readonly PluginUiArtifactRevocationV1[] {
  return Object.freeze([...revocations].sort((left, right) => left.id.localeCompare(right.id)));
}

export function createPluginUiArtifactRevocationFeedSigningInputV1(
  body: PluginUiArtifactRevocationFeedBodyV1,
): string {
  const parsed = PluginUiArtifactRevocationFeedBodyV1Schema.parse({
    ...body,
    revocations: normalizeRevocations(body.revocations),
  });
  return createCanonicalJsonSigningInput(parsed);
}

export function verifyPluginUiArtifactRevocationFeedV1(input: Readonly<{
  envelope: unknown;
  trustRoots: readonly PluginUiArtifactTrustRootV1[];
  minGeneration?: number;
}>): VerifyPluginUiArtifactRevocationFeedV1Result {
  const parsed = PluginUiArtifactRevocationFeedEnvelopeV1Schema.safeParse(input.envelope);
  if (!parsed.success) return { valid: false, reasonCode: 'revocation_feed_invalid' };

  const parsedTrustRoots = z.array(PluginUiArtifactTrustRootV1Schema).safeParse(input.trustRoots);
  if (!parsedTrustRoots.success) return { valid: false, reasonCode: 'trust_root_missing' };

  const envelope = parsed.data;
  if (envelope.body.generation < (input.minGeneration ?? 0)) {
    return { valid: false, reasonCode: 'stale_generation' };
  }

  const trustRoot = parsedTrustRoots.data.find((candidate) => candidate.id === envelope.trustRootId);
  if (!trustRoot) return { valid: false, reasonCode: 'trust_root_missing' };

  const key = trustRoot.keys.find((candidate) => candidate.keyId === envelope.keyId && candidate.alg === envelope.alg);
  if (!key) return { valid: false, reasonCode: 'signing_key_missing' };

  const publicKey = decodeBase64UrlStrict(key.publicKeyBase64Url);
  if (!publicKey || publicKey.byteLength !== tweetnacl.sign.publicKeyLength) {
    return { valid: false, reasonCode: 'invalid_public_key' };
  }

  const signature = decodeBase64UrlStrict(envelope.signature);
  if (!signature || signature.byteLength !== tweetnacl.sign.signatureLength) {
    return { valid: false, reasonCode: 'invalid_signature' };
  }

  const signingInput = new TextEncoder().encode(
    createPluginUiArtifactRevocationFeedSigningInputV1(envelope.body),
  );
  return tweetnacl.sign.detached.verify(signingInput, signature, publicKey)
    ? { valid: true, body: envelope.body }
    : { valid: false, reasonCode: 'bad_signature' };
}
