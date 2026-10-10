import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { HomeConnectionDescriptorV1Schema } from '../auth/accountDirectory.js';
import { isValidBoxBundlePublicKey } from '../crypto/boxPublicKeyValidation.js';
import { isValidEd25519PublicKey } from '../crypto/ed25519.js';
import { verifyAccountContentKeyBindingV1 } from '../crypto/accountContentKeyBindingV1.js';
import { ContentPublicKeyFingerprintSchema } from '../machines/identity/contentPublicKeyFingerprint.js';
import { decodeCanonicalBase64UrlFixedLength } from '../machines/peer/mediation/strictBase64Url.js';
import { RunnerArtifactIdentityV1Schema } from './runnerArtifact.js';
import { TemporaryComputerWorkspaceV1Schema } from '../sessions/authoring/temporaryComputerWorkspaceV1.js';

function encodedBytes(length: number) {
  return z.string().length(Math.ceil(length * 8 / 6)).refine(
    (value) => decodeCanonicalBase64UrlFixedLength(value, length) !== null,
    'Expected canonical unpadded base64url bytes',
  );
}

export const RunnerPublicKeySchema = encodedBytes(32).refine((value) => {
  const bytes = decodeCanonicalBase64UrlFixedLength(value, 32);
  return bytes !== null && isValidEd25519PublicKey(bytes);
}, 'Invalid Ed25519 public key');
export const RunnerSha256CommitmentSchema = encodedBytes(32);
export const RunnerSignatureSchema = encodedBytes(64);
export const RunnerBoxPublicKeySchema = encodedBytes(32).refine(
  (value) => {
    const bytes = decodeCanonicalBase64UrlFixedLength(value, 32);
    return bytes !== null && isValidBoxBundlePublicKey(bytes);
  },
  'Invalid X25519 public key',
);

// Activation bindings carry existing persisted Account/Session/Machine ids;
// the supported MySQL string identity columns are bounded to 191 characters.
export const RunnerResourceIdSchema = lazyZodSchema(() => z.string().min(1).max(191).refine((value) => value.trim() === value));

export const RunnerEndpointFactsRecipientV1Schema = lazyZodSchema(() => z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('plain'), creatorAccountId: RunnerResourceIdSchema }).strict(),
  z.object({
    mode: z.literal('e2ee'),
    creatorAccountId: RunnerResourceIdSchema,
    accountSigningPublicKey: RunnerPublicKeySchema,
    contentPublicKey: RunnerBoxPublicKeySchema,
    contentPublicKeySignature: RunnerSignatureSchema,
    contentPublicKeyFingerprint: ContentPublicKeyFingerprintSchema,
  }).strict(),
]).superRefine((recipient, ctx) => {
  if (recipient.mode === 'plain') return;
  const accountSigningPublicKey = decodeCanonicalBase64UrlFixedLength(recipient.accountSigningPublicKey, 32);
  const contentPublicKey = decodeCanonicalBase64UrlFixedLength(recipient.contentPublicKey, 32);
  const signature = decodeCanonicalBase64UrlFixedLength(recipient.contentPublicKeySignature, 64);
  const verified = accountSigningPublicKey && contentPublicKey && signature
    ? verifyAccountContentKeyBindingV1({ accountSigningPublicKey, contentPublicKey, signature })
    : null;
  if (!verified || verified.contentPublicKeyFingerprint !== recipient.contentPublicKeyFingerprint) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid Account content-key binding' });
  }
}));
export type RunnerEndpointFactsRecipientV1 = z.infer<typeof RunnerEndpointFactsRecipientV1Schema>;

const CanonicalHomeIdentitySchema = lazyZodSchema(() => z.string().refine((value) => {
  const parsed = HomeConnectionDescriptorV1Schema.shape.homeServerIdentityId.safeParse(value);
  return parsed.success && parsed.data === value;
}));

const RunnerActivationBindingFieldsV1Schema = lazyZodSchema(() => z.object({
  activationId: z.string().uuid(),
  homeServerIdentityId: CanonicalHomeIdentitySchema,
  creatorAccountId: RunnerResourceIdSchema,
  creatorTokenEpoch: z.number().int().nonnegative().safe(),
  activationExpiresAt: z.number().int().nonnegative().safe().nullable(),
  workspace: TemporaryComputerWorkspaceV1Schema,
  sessionId: RunnerResourceIdSchema,
  machineId: RunnerResourceIdSchema,
  activationSigningPublicKey: RunnerPublicKeySchema,
  authoringCommitment: RunnerSha256CommitmentSchema,
  artifact: RunnerArtifactIdentityV1Schema,
  endpointFactsRecipient: RunnerEndpointFactsRecipientV1Schema,
}).strict());

export const RunnerActivationBindingV1Schema = lazyZodSchema(() => RunnerActivationBindingFieldsV1Schema.refine(
  (binding) => binding.creatorAccountId === binding.endpointFactsRecipient.creatorAccountId,
  'Recipient must belong to the authenticated creator',
));
export type RunnerActivationBindingV1 = z.infer<typeof RunnerActivationBindingV1Schema>;

export const RunnerActivationCreateRequestV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  activationId: z.string().uuid(),
  draftId: RunnerResourceIdSchema,
  /** Explicit creator consent for this exact activation to retain current Team-authentication evidence. */
  authorizeUnattendedTeamAccess: z.literal(true).optional(),
  homeServerIdentityId: CanonicalHomeIdentitySchema,
  activationSigningPublicKey: RunnerPublicKeySchema,
  activationExpiresAt: z.number().int().nonnegative().safe().nullable(),
  workspace: TemporaryComputerWorkspaceV1Schema,
  authoringCommitment: RunnerSha256CommitmentSchema,
  artifact: RunnerArtifactIdentityV1Schema,
  endpointFactsRecipient: RunnerEndpointFactsRecipientV1Schema,
}).strict());
export type RunnerActivationCreateRequestV1 = z.infer<typeof RunnerActivationCreateRequestV1Schema>;

export const RunnerActivationStateV1Schema = lazyZodSchema(() => z.enum(['pending', 'claimed', 'consented', 'materialized', 'closed']));

export const RunnerActivationCloseReasonV1Schema = lazyZodSchema(() => z.enum(['canceled', 'declined', 'expired', 'revoked', 'failed']));
