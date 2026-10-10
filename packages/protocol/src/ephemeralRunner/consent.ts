import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { encodeBase64 } from '../crypto/base64.js';
import { signEd25519Message, verifyEd25519Signature } from '../crypto/ed25519.js';
import { decodeCanonicalBase64UrlFixedLength } from '../machines/peer/mediation/strictBase64Url.js';
import { RunnerSha256CommitmentSchema, RunnerSignatureSchema } from './activation.js';
import { RunnerClaimPayloadV1Schema, verifyRunnerClaimV1 } from './endpoint.js';

export const RunnerConsentPayloadV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  purpose: z.literal('happier.ephemeral-session-runner.consent'),
  allow: z.literal(true),
  claim: RunnerClaimPayloadV1Schema,
  launchManifestCommitment: RunnerSha256CommitmentSchema,
}).strict());
export type RunnerConsentPayloadV1 = z.infer<typeof RunnerConsentPayloadV1Schema>;

export const RunnerConsentV1Schema = lazyZodSchema(() => z.object({
  payload: RunnerConsentPayloadV1Schema,
  activationSignature: RunnerSignatureSchema,
  installationSignature: RunnerSignatureSchema,
}).strict());
export type RunnerConsentV1 = z.infer<typeof RunnerConsentV1Schema>;

export function signRunnerConsentV1(params: Readonly<{
  payload: RunnerConsentPayloadV1;
  activationSecretKey: Uint8Array;
  installationSecretKey: Uint8Array;
}>): RunnerConsentV1 {
  const payload = RunnerConsentPayloadV1Schema.parse(params.payload);
  const bytes = new TextEncoder().encode(createCanonicalJsonSigningInput(payload));
  return {
    payload,
    activationSignature: encodeBase64(signEd25519Message(bytes, params.activationSecretKey), 'base64url'),
    installationSignature: encodeBase64(signEd25519Message(bytes, params.installationSecretKey), 'base64url'),
  };
}

/** Verifies cryptographic authorization; the activation transaction owns state, expiry and Account currentness. */
export function verifyRunnerConsentV1(params: Readonly<{
  consent: unknown;
  claim: unknown;
  expectedBinding: unknown;
  expectedLaunchManifestCommitment: string;
}>): RunnerConsentV1 | null {
  const consent = RunnerConsentV1Schema.safeParse(params.consent);
  const claim = verifyRunnerClaimV1({ claim: params.claim, expectedBinding: params.expectedBinding });
  if (!consent.success || !claim) return null;
  if (consent.data.payload.launchManifestCommitment !== params.expectedLaunchManifestCommitment) return null;
  if (createCanonicalJsonSigningInput(consent.data.payload.claim) !== createCanonicalJsonSigningInput(claim.payload)) return null;

  const bytes = new TextEncoder().encode(createCanonicalJsonSigningInput(consent.data.payload));
  const signatures = [
    [consent.data.activationSignature, claim.payload.binding.activationSigningPublicKey],
    [consent.data.installationSignature, claim.payload.installation.publicKey],
  ] as const;
  for (const [signature, publicKey] of signatures) {
    const signatureBytes = decodeCanonicalBase64UrlFixedLength(signature, 64);
    const publicKeyBytes = decodeCanonicalBase64UrlFixedLength(publicKey, 32);
    if (!signatureBytes || !publicKeyBytes || !verifyEd25519Signature(bytes, signatureBytes, publicKeyBytes)) return null;
  }
  return consent.data;
}
