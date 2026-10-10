import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { IrohEndpointIdV1Schema } from '../connectivity/iroh/endpointDescriptorV1.js';
import { encodeBase64 } from '../crypto/base64.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { signEd25519Message, verifyEd25519Signature } from '../crypto/ed25519.js';
import { decodeCanonicalBase64UrlFixedLength } from '../machines/peer/mediation/strictBase64Url.js';
import { ProviderWireProtocolSchema } from '../providers/capabilities/v1.js';
import { ProviderAgentTargetKeySchema, ProviderModelIdSchema } from '../providers/ids.js';
import { RunnerResourceIdSchema, RunnerSha256CommitmentSchema, RunnerSignatureSchema } from './activation.js';
import { RunnerClaimV1Schema, verifyRunnerClaimV1 } from './endpoint.js';

export const RunnerBrokerReadinessFactsV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  kind: z.literal('provider_broker_readiness'),
  homeServerIdentityId: RunnerResourceIdSchema,
  activationId: z.string().uuid(),
  launchManifestCommitment: RunnerSha256CommitmentSchema,
  resourceId: RunnerResourceIdSchema,
  agentTargetKey: ProviderAgentTargetKeySchema,
  modelId: ProviderModelIdSchema,
  protocol: ProviderWireProtocolSchema,
  initiator: z.object({
    installationId: RunnerResourceIdSchema,
    endpointId: IrohEndpointIdV1Schema,
  }).strict(),
  target: z.object({
    machineId: RunnerResourceIdSchema,
    endpointId: IrohEndpointIdV1Schema,
  }).strict(),
}).strict());
export type RunnerBrokerReadinessFactsV1 = z.infer<typeof RunnerBrokerReadinessFactsV1Schema>;

export const RunnerBrokerReadinessRequestV1Schema = lazyZodSchema(() => RunnerBrokerReadinessFactsV1Schema.extend({
  activationSignature: RunnerSignatureSchema,
  installationSignature: RunnerSignatureSchema,
}).strict());
export type RunnerBrokerReadinessRequestV1 = z.infer<typeof RunnerBrokerReadinessRequestV1Schema>;

export const IrohRunnerBrokerReadinessHandshakeV1Schema = RunnerBrokerReadinessRequestV1Schema;
export type IrohRunnerBrokerReadinessHandshakeV1 = RunnerBrokerReadinessRequestV1;

function signingBytes(facts: RunnerBrokerReadinessFactsV1): Uint8Array {
  return new TextEncoder().encode(createRunnerBrokerReadinessSigningInputV1(facts));
}

function requestFacts(request: RunnerBrokerReadinessRequestV1): RunnerBrokerReadinessFactsV1 {
  return {
    v: request.v,
    kind: request.kind,
    homeServerIdentityId: request.homeServerIdentityId,
    activationId: request.activationId,
    launchManifestCommitment: request.launchManifestCommitment,
    resourceId: request.resourceId,
    agentTargetKey: request.agentTargetKey,
    modelId: request.modelId,
    protocol: request.protocol,
    initiator: request.initiator,
    target: request.target,
  };
}

export function createRunnerBrokerReadinessSigningInputV1(facts: RunnerBrokerReadinessFactsV1): string {
  const request = RunnerBrokerReadinessRequestV1Schema.safeParse(facts);
  const value = request.success ? requestFacts(request.data) : facts;
  return `happier.provider-broker.readiness-request.v1\n${createCanonicalJsonSigningInput(
    RunnerBrokerReadinessFactsV1Schema.parse(value),
  )}`;
}

export function signRunnerBrokerReadinessRequestV1(input: Readonly<{
  facts: RunnerBrokerReadinessFactsV1;
  claim: z.input<typeof RunnerClaimV1Schema>;
  activationSecretKey: Uint8Array;
  installationSecretKey: Uint8Array;
}>): RunnerBrokerReadinessRequestV1 {
  const facts = RunnerBrokerReadinessFactsV1Schema.parse(input.facts);
  const claim = RunnerClaimV1Schema.parse(input.claim);
  if (
    facts.activationId !== claim.payload.binding.activationId
    || facts.homeServerIdentityId !== claim.payload.binding.homeServerIdentityId
    || facts.initiator.installationId !== claim.payload.installation.installationId
  ) throw new TypeError('Runner broker readiness facts do not match the verified claim');
  const bytes = signingBytes(facts);
  return RunnerBrokerReadinessRequestV1Schema.parse({
    ...facts,
    activationSignature: encodeBase64(signEd25519Message(bytes, input.activationSecretKey), 'base64url'),
    installationSignature: encodeBase64(signEd25519Message(bytes, input.installationSecretKey), 'base64url'),
  });
}

export function verifyRunnerBrokerReadinessRequestV1(input: Readonly<{
  request: unknown;
  claim: unknown;
  expectedBinding: unknown;
  expectedFacts: unknown;
}>): RunnerBrokerReadinessRequestV1 | null {
  const request = RunnerBrokerReadinessRequestV1Schema.safeParse(input.request);
  const expectedFacts = RunnerBrokerReadinessFactsV1Schema.safeParse(input.expectedFacts);
  const claim = verifyRunnerClaimV1({ claim: input.claim, expectedBinding: input.expectedBinding });
  if (!request.success || !expectedFacts.success || !claim) return null;
  const facts = requestFacts(request.data);
  if (
    createCanonicalJsonSigningInput(facts) !== createCanonicalJsonSigningInput(expectedFacts.data)
    || facts.activationId !== claim.payload.binding.activationId
    || facts.homeServerIdentityId !== claim.payload.binding.homeServerIdentityId
    || facts.initiator.installationId !== claim.payload.installation.installationId
  ) return null;
  const bytes = signingBytes(facts);
  for (const [signature, publicKey] of [
    [request.data.activationSignature, claim.payload.binding.activationSigningPublicKey],
    [request.data.installationSignature, claim.payload.installation.publicKey],
  ] as const) {
    const signatureBytes = decodeCanonicalBase64UrlFixedLength(signature, 64);
    const publicKeyBytes = decodeCanonicalBase64UrlFixedLength(publicKey, 32);
    if (!signatureBytes || !publicKeyBytes || !verifyEd25519Signature(bytes, signatureBytes, publicKeyBytes)) return null;
  }
  return request.data;
}
