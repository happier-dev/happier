import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { AgentExecutionTargetV1Schema } from '../agents/executionTargetV1.js';
import { RunnerClaimPayloadV1Schema } from './endpoint.js';
import { RunnerResourceIdSchema, RunnerSha256CommitmentSchema, RunnerSignatureSchema } from './activation.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { encodeBase64 } from '../crypto/base64.js';
import { signEd25519Message, verifyEd25519Signature } from '../crypto/ed25519.js';
import { decodeCanonicalBase64UrlFixedLength } from '../machines/peer/mediation/strictBase64Url.js';
import { verifyRunnerClaimV1 } from './endpoint.js';
import { RunnerCredentialSelectionBindingV1Schema } from './review.js';
import { RunnerBrokerReadinessRequestV1Schema } from './brokerReadinessRequestV1.js';

export const RunnerManagedAgentInstallationV1Schema = lazyZodSchema(() => z.object({
  agentTarget: AgentExecutionTargetV1Schema,
  // Canonical Agent runtime descriptor, not an installer-issued attestation.
  agentRuntimeId: RunnerResourceIdSchema,
  executablePath: z.string().min(1).max(16 * 1024),
  authoritativeVersion: z.string().min(1).max(512).nullable(),
}).strict());

export const RunnerReadinessPayloadV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  purpose: z.literal('happier.ephemeral-session-runner.readiness'),
  claim: RunnerClaimPayloadV1Schema,
  launchManifestCommitment: RunnerSha256CommitmentSchema,
  installation: RunnerManagedAgentInstallationV1Schema,
  credentialSelectionBinding: RunnerCredentialSelectionBindingV1Schema,
  brokerReadinessRequest: RunnerBrokerReadinessRequestV1Schema,
}).strict());
export type RunnerReadinessPayloadV1 = z.infer<typeof RunnerReadinessPayloadV1Schema>;

export const RunnerReadinessV1Schema = lazyZodSchema(() => z.object({
  payload: RunnerReadinessPayloadV1Schema,
  activationSignature: RunnerSignatureSchema,
  installationSignature: RunnerSignatureSchema,
}).strict());
export type RunnerReadinessV1 = z.infer<typeof RunnerReadinessV1Schema>;

export function signRunnerReadinessV1(params: Readonly<{ payload: RunnerReadinessPayloadV1; activationSecretKey: Uint8Array; installationSecretKey: Uint8Array }>): RunnerReadinessV1 {
  const payload = RunnerReadinessPayloadV1Schema.parse(params.payload);
  const bytes = new TextEncoder().encode(createCanonicalJsonSigningInput(payload));
  return { payload,
    activationSignature: encodeBase64(signEd25519Message(bytes, params.activationSecretKey), 'base64url'),
    installationSignature: encodeBase64(signEd25519Message(bytes, params.installationSecretKey), 'base64url'),
  };
}

export function verifyRunnerReadinessV1(params: Readonly<{ readiness: unknown; claim: unknown; expectedBinding: unknown; expectedLaunchManifestCommitment: string }>): RunnerReadinessV1 | null {
  const readiness = RunnerReadinessV1Schema.safeParse(params.readiness);
  const claim = verifyRunnerClaimV1({ claim: params.claim, expectedBinding: params.expectedBinding });
  if (!readiness.success || !claim || readiness.data.payload.launchManifestCommitment !== params.expectedLaunchManifestCommitment
    || createCanonicalJsonSigningInput(readiness.data.payload.claim) !== createCanonicalJsonSigningInput(claim.payload)) return null;
  const broker = readiness.data.payload.brokerReadinessRequest;
  const selection = readiness.data.payload.credentialSelectionBinding;
  if (broker.activationId !== claim.payload.binding.activationId
    || broker.homeServerIdentityId !== claim.payload.binding.homeServerIdentityId
    || broker.launchManifestCommitment !== readiness.data.payload.launchManifestCommitment
    || broker.initiator.installationId !== claim.payload.installation.installationId
    || broker.resourceId !== selection.resourceId
    || broker.target.machineId !== selection.brokerMachineId) return null;
  const bytes = new TextEncoder().encode(createCanonicalJsonSigningInput(readiness.data.payload));
  for (const [encodedSignature, encodedKey] of [
    [readiness.data.activationSignature, claim.payload.binding.activationSigningPublicKey],
    [readiness.data.installationSignature, claim.payload.installation.publicKey],
  ] as const) {
    const signature = decodeCanonicalBase64UrlFixedLength(encodedSignature, 64);
    const key = decodeCanonicalBase64UrlFixedLength(encodedKey, 32);
    if (!signature || !key || !verifyEd25519Signature(bytes, signature, key)) return null;
  }
  return readiness.data;
}
