import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { encodeBase64 } from '../crypto/base64.js';
import { signEd25519Message, verifyEd25519Signature } from '../crypto/ed25519.js';
import { BOX_BUNDLE_MIN_BYTES, BOX_BUNDLE_PUBLIC_KEY_BYTES } from '../crypto/boxBundleFormat.js';
import { isValidBoxBundlePublicKey } from '../crypto/boxPublicKeyValidation.js';
import { StoredJsonContentEnvelopeSchema } from '../storage/storedJsonContentEnvelope.js';
import { ABSOLUTE_WORKSPACE_PATH_MAX_LENGTH, AbsoluteWorkspacePathSchema } from '../workspaces/locationSchema.js';
import { MachineInstallationProofV1Schema, verifyMachineInstallationProof } from '../machines/identity/installationIdentity.js';
import { decodeCanonicalBase64UrlFixedLength } from '../machines/peer/mediation/strictBase64Url.js';
import {
  RunnerActivationBindingV1Schema,
  RunnerBoxPublicKeySchema,
  RunnerPublicKeySchema,
  RunnerResourceIdSchema,
  RunnerSignatureSchema,
} from './activation.js';

export const RunnerClaimPayloadV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  purpose: z.literal('happier.ephemeral-session-runner.claim'),
  binding: RunnerActivationBindingV1Schema,
  runnerBoxPublicKey: RunnerBoxPublicKeySchema,
  installation: z.object({
    installationId: RunnerResourceIdSchema,
    publicKey: RunnerPublicKeySchema,
    proof: MachineInstallationProofV1Schema.extend({ signature: RunnerSignatureSchema }).strict(),
  }).strict(),
  protocolEpoch: z.literal(1),
}).strict());
export type RunnerClaimPayloadV1 = z.infer<typeof RunnerClaimPayloadV1Schema>;

export const RunnerClaimV1Schema = lazyZodSchema(() => z.object({
  payload: RunnerClaimPayloadV1Schema,
  signature: RunnerSignatureSchema,
}).strict());
export type RunnerClaimV1 = z.infer<typeof RunnerClaimV1Schema>;

export function signRunnerClaimV1(params: Readonly<{
  payload: RunnerClaimPayloadV1;
  activationSecretKey: Uint8Array;
}>): RunnerClaimV1 {
  const payload = RunnerClaimPayloadV1Schema.parse(params.payload);
  return {
    payload,
    signature: encodeBase64(signEd25519Message(
      new TextEncoder().encode(createCanonicalJsonSigningInput(payload)), params.activationSecretKey,
    ), 'base64url'),
  };
}

/** The expected binding comes from creator-local custody or the activation row, never the relayed claim. */
export function verifyRunnerClaimV1(params: Readonly<{
  claim: unknown;
  expectedBinding: unknown;
}>): RunnerClaimV1 | null {
  const claim = RunnerClaimV1Schema.safeParse(params.claim);
  const expected = RunnerActivationBindingV1Schema.safeParse(params.expectedBinding);
  if (!claim.success || !expected.success) return null;
  if (createCanonicalJsonSigningInput(claim.data.payload.binding) !== createCanonicalJsonSigningInput(expected.data)) return null;

  const signature = decodeCanonicalBase64UrlFixedLength(claim.data.signature, 64);
  const activationKey = decodeCanonicalBase64UrlFixedLength(expected.data.activationSigningPublicKey, 32);
  if (!signature || !activationKey) return null;
  if (!verifyEd25519Signature(
    new TextEncoder().encode(createCanonicalJsonSigningInput(claim.data.payload)), signature, activationKey,
  )) return null;

  const installation = claim.data.payload.installation;
  if (!verifyMachineInstallationProof({
    payload: {
      version: 1,
      installationId: installation.installationId,
      machineId: expected.data.machineId,
      accountId: expected.data.creatorAccountId,
    },
    proof: installation.proof,
    publicKey: installation.publicKey,
  })) return null;
  return claim.data;
}

// These are the exact runtime facts the endpoint can authoritatively observe.
// The creator freezes them into the reviewed launch manifest and derives both
// Session and Machine metadata from that one reviewed value. The Home may relay
// the signed envelope but never supplies replacement metadata.
const RUNNER_ENDPOINT_HOST_MAX_LENGTH = 255;
const RUNNER_ENDPOINT_CLI_VERSION_MAX_LENGTH = 191;
export const RunnerEndpointMachineFactsV1Schema = lazyZodSchema(() => z.object({
  host: z.string().min(1).max(RUNNER_ENDPOINT_HOST_MAX_LENGTH),
  platform: z.enum(['darwin', 'linux', 'win32']),
  happyCliVersion: z.string().min(1).max(RUNNER_ENDPOINT_CLI_VERSION_MAX_LENGTH)
    .refine((value) => value.trim() === value),
  happyHomeDir: AbsoluteWorkspacePathSchema,
  homeDir: AbsoluteWorkspacePathSchema,
}).strict());
export type RunnerEndpointMachineFactsV1 = z.infer<typeof RunnerEndpointMachineFactsV1Schema>;

export const RunnerEndpointFactsContentV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  directory: AbsoluteWorkspacePathSchema,
  machine: RunnerEndpointMachineFactsV1Schema,
}).strict());
export type RunnerEndpointFactsContentV1 = z.infer<typeof RunnerEndpointFactsContentV1Schema>;

// Encrypted facts contain compact UTF-8 JSON. A UTF-16 string unit needs at
// most six JSON escape bytes, so this bounds decoding to the strict schema's
// complete accepted input rather than introducing a separate request limit.
const ENDPOINT_FACTS_MAX_JSON_BYTES = JSON.stringify({
  v: 1,
  directory: '',
  machine: { host: '', platform: 'linux', happyCliVersion: '', happyHomeDir: '', homeDir: '' },
}).length + (
  ABSOLUTE_WORKSPACE_PATH_MAX_LENGTH * 3
  + RUNNER_ENDPOINT_HOST_MAX_LENGTH
  + RUNNER_ENDPOINT_CLI_VERSION_MAX_LENGTH
) * 6;
const ENDPOINT_FACTS_MAX_CIPHER_CHARACTERS = Math.ceil((ENDPOINT_FACTS_MAX_JSON_BYTES + BOX_BUNDLE_MIN_BYTES) * 8 / 6);

export const RunnerEndpointFactsStoredContentV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  StoredJsonContentEnvelopeSchema.options[0].extend({ v: RunnerEndpointFactsContentV1Schema }).strict(),
  StoredJsonContentEnvelopeSchema.options[1].extend({
    // The pipe stops oversized input before base64 decoding and key validation.
    c: z.string().max(ENDPOINT_FACTS_MAX_CIPHER_CHARACTERS).pipe(z.string().refine((value) => {
      const bytes = decodeCanonicalBase64UrlFixedLength(value, Math.floor(value.length * 6 / 8));
      return bytes !== null && bytes.length > BOX_BUNDLE_MIN_BYTES
        && isValidBoxBundlePublicKey(bytes.subarray(0, BOX_BUNDLE_PUBLIC_KEY_BYTES));
    }, 'Endpoint facts must use a canonical sealed box bundle')),
  }).strict(),
]));

export const RunnerEndpointFactsPayloadV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  purpose: z.literal('happier.ephemeral-session-runner.endpoint-facts'),
  claim: RunnerClaimPayloadV1Schema,
  content: RunnerEndpointFactsStoredContentV1Schema,
}).strict());
export type RunnerEndpointFactsPayloadV1 = z.infer<typeof RunnerEndpointFactsPayloadV1Schema>;

export const RunnerEndpointFactsV1Schema = lazyZodSchema(() => z.object({
  payload: RunnerEndpointFactsPayloadV1Schema,
  activationSignature: RunnerSignatureSchema,
  installationSignature: RunnerSignatureSchema,
}).strict());
export type RunnerEndpointFactsV1 = z.infer<typeof RunnerEndpointFactsV1Schema>;

export function signRunnerEndpointFactsV1(params: Readonly<{
  payload: RunnerEndpointFactsPayloadV1;
  activationSecretKey: Uint8Array;
  installationSecretKey: Uint8Array;
}>): RunnerEndpointFactsV1 {
  const payload = RunnerEndpointFactsPayloadV1Schema.parse(params.payload);
  const bytes = new TextEncoder().encode(createCanonicalJsonSigningInput(payload));
  return { payload,
    activationSignature: encodeBase64(signEd25519Message(bytes, params.activationSecretKey), 'base64url'),
    installationSignature: encodeBase64(signEd25519Message(bytes, params.installationSecretKey), 'base64url'),
  };
}

/** A second package holder cannot rewrite the winning installation's facts. */
export function verifyRunnerEndpointFactsV1(params: Readonly<{
  endpointFacts: unknown;
  claim: unknown;
  expectedBinding: unknown;
}>): RunnerEndpointFactsV1 | null {
  const facts = RunnerEndpointFactsV1Schema.safeParse(params.endpointFacts);
  const claim = verifyRunnerClaimV1({ claim: params.claim, expectedBinding: params.expectedBinding });
  if (!facts.success || !claim) return null;
  if (createCanonicalJsonSigningInput(facts.data.payload.claim) !== createCanonicalJsonSigningInput(claim.payload)) return null;
  const bytes = new TextEncoder().encode(createCanonicalJsonSigningInput(facts.data.payload));
  const signatures = [
    [facts.data.activationSignature, claim.payload.binding.activationSigningPublicKey],
    [facts.data.installationSignature, claim.payload.installation.publicKey],
  ] as const;
  for (const [signature, publicKey] of signatures) {
    const signatureBytes = decodeCanonicalBase64UrlFixedLength(signature, 64);
    const publicKeyBytes = decodeCanonicalBase64UrlFixedLength(publicKey, 32);
    if (!signatureBytes || !publicKeyBytes || !verifyEd25519Signature(bytes, signatureBytes, publicKeyBytes)) return null;
  }
  return facts.data;
}
