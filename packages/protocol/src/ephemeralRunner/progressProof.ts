import { z } from '../zodRuntimePolicy.js';
import tweetnacl from 'tweetnacl';

import { RunnerPublicKeySchema, RunnerResourceIdSchema, RunnerSignatureSchema } from './activation.js';
import { RunnerActivationProgressPhaseV1Schema } from './progress.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { encodeBase64 } from '../crypto/base64.js';
import { verifyEd25519Signature } from '../crypto/ed25519.js';
import { decodeCanonicalBase64UrlFixedLength } from '../machines/peer/mediation/strictBase64Url.js';

export const RunnerActivationProgressPayloadV1Schema = z.strictObject({
  v: z.literal(1),
  purpose: z.literal('happier.ephemeral-session-runner.activation-progress'),
  activationId: z.string().check(z.uuid()),
  sessionId: RunnerResourceIdSchema,
  machineId: RunnerResourceIdSchema,
  creatorTokenEpoch: z.number().check(z.int(), z.nonnegative(), z.int()),
  phase: RunnerActivationProgressPhaseV1Schema,
});

export const RunnerActivationProgressUpdateV1Schema = z.strictObject({
  payload: RunnerActivationProgressPayloadV1Schema,
  activationSignature: RunnerSignatureSchema,
  installationSignature: RunnerSignatureSchema,
});
export type RunnerActivationProgressUpdateV1 = z.infer<typeof RunnerActivationProgressUpdateV1Schema>;

export function signRunnerActivationProgressUpdateV1(params: Readonly<{
  payload: z.input<typeof RunnerActivationProgressPayloadV1Schema>;
  activationSecretKey: Uint8Array;
  installationSecretKey: Uint8Array;
}>): RunnerActivationProgressUpdateV1 {
  const payload = RunnerActivationProgressPayloadV1Schema.parse(params.payload);
  const bytes = new TextEncoder().encode(createCanonicalJsonSigningInput(payload));
  return {
    payload,
    activationSignature: encodeBase64(tweetnacl.sign.detached(bytes, params.activationSecretKey), 'base64url'),
    installationSignature: encodeBase64(tweetnacl.sign.detached(bytes, params.installationSecretKey), 'base64url'),
  };
}

export function verifyRunnerActivationProgressUpdateV1(params: Readonly<{
  update: unknown;
  expectedPayload: unknown;
  activationSigningPublicKey: z.input<typeof RunnerPublicKeySchema>;
  installationPublicKey: z.input<typeof RunnerPublicKeySchema>;
}>): RunnerActivationProgressUpdateV1 | null {
  const update = RunnerActivationProgressUpdateV1Schema.safeParse(params.update);
  const expected = RunnerActivationProgressPayloadV1Schema.safeParse(params.expectedPayload);
  const activationKey = RunnerPublicKeySchema.safeParse(params.activationSigningPublicKey);
  const installationKey = RunnerPublicKeySchema.safeParse(params.installationPublicKey);
  if (!update.success || !expected.success || !activationKey.success || !installationKey.success
    || createCanonicalJsonSigningInput(update.data.payload) !== createCanonicalJsonSigningInput(expected.data)) return null;
  const bytes = new TextEncoder().encode(createCanonicalJsonSigningInput(update.data.payload));
  for (const [encodedSignature, encodedKey] of [
    [update.data.activationSignature, activationKey.data],
    [update.data.installationSignature, installationKey.data],
  ] as const) {
    const signature = decodeCanonicalBase64UrlFixedLength(encodedSignature, 64);
    const key = decodeCanonicalBase64UrlFixedLength(encodedKey, 32);
    if (!signature || !key || !verifyEd25519Signature(bytes, signature, key)) return null;
  }
  return update.data;
}
