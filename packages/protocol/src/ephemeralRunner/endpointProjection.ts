import { z } from '../zodRuntimePolicy.js';
import tweetnacl from 'tweetnacl';

import { RunnerPublicKeySchema, RunnerResourceIdSchema, RunnerSha256CommitmentSchema, RunnerSignatureSchema } from './activation.js';
import { RunnerActivationProjectionV1Schema } from './projection.js';
import { RunnerBrokerReadinessProjectionV1Schema } from '../teams/credentials/readinessV1.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { encodeBase64 } from '../crypto/base64.js';
import { decodeCanonicalBase64UrlFixedLength } from '../machines/peer/mediation/strictBase64Url.js';
import { verifyEd25519Signature } from '../crypto/ed25519.js';

export const RunnerEndpointProjectionProofPayloadV1Schema = z.strictObject({
  v: z.literal(1),
  purpose: z.literal('happier.ephemeral-session-runner.endpoint-projection'),
  activationId: z.string().check(z.uuid()),
  sessionId: RunnerResourceIdSchema,
  machineId: RunnerResourceIdSchema,
  launchManifestCommitment: z.nullable(RunnerSha256CommitmentSchema),
  creatorTokenEpoch: z.number().check(z.int(), z.nonnegative(), z.int()),
});

export const RunnerEndpointProjectionRequestV1Schema = z.strictObject({
  payload: RunnerEndpointProjectionProofPayloadV1Schema,
  activationSignature: RunnerSignatureSchema,
  installationSignature: RunnerSignatureSchema,
});
export type RunnerEndpointProjectionRequestV1 = z.infer<typeof RunnerEndpointProjectionRequestV1Schema>;

export function signRunnerEndpointProjectionProofV1(params: Readonly<{
  payload: z.input<typeof RunnerEndpointProjectionProofPayloadV1Schema>;
  activationSecretKey: Uint8Array;
  installationSecretKey: Uint8Array;
}>): RunnerEndpointProjectionRequestV1 {
  const payload = RunnerEndpointProjectionProofPayloadV1Schema.parse(params.payload);
  const bytes = new TextEncoder().encode(createCanonicalJsonSigningInput(payload));
  return { payload,
    activationSignature: encodeBase64(tweetnacl.sign.detached(bytes, params.activationSecretKey), 'base64url'),
    installationSignature: encodeBase64(tweetnacl.sign.detached(bytes, params.installationSecretKey), 'base64url'),
  };
}

export function verifyRunnerEndpointProjectionProofV1(params: Readonly<{
  request: unknown;
  expectedPayload: unknown;
  activationSigningPublicKey: z.input<typeof RunnerPublicKeySchema>;
  installationPublicKey: z.input<typeof RunnerPublicKeySchema>;
}>): RunnerEndpointProjectionRequestV1 | null {
  const request = RunnerEndpointProjectionRequestV1Schema.safeParse(params.request);
  const expected = RunnerEndpointProjectionProofPayloadV1Schema.safeParse(params.expectedPayload);
  const activationKey = RunnerPublicKeySchema.safeParse(params.activationSigningPublicKey);
  const installationKey = RunnerPublicKeySchema.safeParse(params.installationPublicKey);
  if (!request.success || !expected.success || !activationKey.success || !installationKey.success
    || createCanonicalJsonSigningInput(request.data.payload) !== createCanonicalJsonSigningInput(expected.data)) return null;
  const bytes = new TextEncoder().encode(createCanonicalJsonSigningInput(request.data.payload));
  for (const [encodedSignature, encodedKey] of [
    [request.data.activationSignature, activationKey.data],
    [request.data.installationSignature, installationKey.data],
  ] as const) {
    const signature = decodeCanonicalBase64UrlFixedLength(encodedSignature, 64);
    const key = decodeCanonicalBase64UrlFixedLength(encodedKey, 32);
    if (!signature || !key || !verifyEd25519Signature(bytes, signature, key)) return null;
  }
  return request.data;
}

export const RunnerEndpointProjectionResponseV1Schema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('pending'),
    activation: RunnerActivationProjectionV1Schema,
    brokerReadiness: z.nullable(RunnerBrokerReadinessProjectionV1Schema),
  }),
  z.strictObject({
    status: z.literal('materialized'),
    activation: RunnerActivationProjectionV1Schema,
    runtimeToken: z.string().check(z.minLength(1), z.maxLength(16 * 1024)),
    sealedBootstrap: z.string().check(z.minLength(1), z.maxLength(1024 * 1024)),
  }),
  z.strictObject({
    status: z.literal('unavailable'),
    reason: z.enum(['activation_closed', 'activation_expired', 'creator_unavailable', 'recipient_mismatch', 'not_materialized']),
  }),
  z.strictObject({ status: z.literal('conflict'), reason: z.enum(['proof_mismatch', 'installation_mismatch', 'manifest_mismatch']) }),
]);
export type RunnerEndpointProjectionResponseV1 = z.infer<typeof RunnerEndpointProjectionResponseV1Schema>;

export const RunnerEndpointDeclineResponseV1Schema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('declined') }),
  z.strictObject({
    status: z.literal('unavailable'),
    reason: z.enum(['activation_closed', 'activation_expired', 'creator_unavailable', 'recipient_mismatch', 'already_materialized']),
  }),
  z.strictObject({ status: z.literal('conflict'), reason: z.literal('proof_mismatch') }),
]);
export type RunnerEndpointDeclineResponseV1 = z.infer<typeof RunnerEndpointDeclineResponseV1Schema>;
