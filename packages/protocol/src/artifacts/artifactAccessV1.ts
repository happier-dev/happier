import { z } from 'zod';

import { PrincipalRefV1Schema } from '../teams/principal.js';
import { AccountEncryptionModeSchema } from '../features/payload/capabilities/encryptionCapabilities.js';
import { ContentPublicKeyFingerprintSchema } from '../machines/identity/contentPublicKeyFingerprint.js';
import {
  SessionDataKeyEnvelopeBytesV1Schema,
  SessionDataKeyRecipientContentKeyV1Schema,
} from '../sessions/encryption/sessionDataKeyEnvelopes.js';

/** Document grant wire epoch V1. Every identity, mutation and nested object is closed. */
export const ARTIFACT_ACCESS_ACTION_IDS_V1 = [
  'artifact.access.grants.list', 'artifact.access.grants.set', 'artifact.access.grants.remove',
] as const;
export const ArtifactAccessActionIdV1Schema = z.enum(ARTIFACT_ACCESS_ACTION_IDS_V1);
export type ArtifactAccessActionIdV1 = z.infer<typeof ArtifactAccessActionIdV1Schema>;

export const ArtifactAccessLevelV1Schema = z.enum(['view', 'edit', 'admin']);
export type ArtifactAccessLevelV1 = z.infer<typeof ArtifactAccessLevelV1Schema>;
export const ArtifactCallerAccessV1Schema = z.enum(['owner', 'view', 'edit', 'admin']);
export type ArtifactCallerAccessV1 = z.infer<typeof ArtifactCallerAccessV1Schema>;

export const ArtifactAccessGrantsListInputV1Schema = z.object({ artifactId: z.string().min(1) }).strict();
export const ArtifactAccessGrantSetInputV1Schema = ArtifactAccessGrantsListInputV1Schema.extend({
  principal: PrincipalRefV1Schema,
  accessLevel: ArtifactAccessLevelV1Schema,
}).strict();
export const ArtifactAccessGrantRemoveInputV1Schema = ArtifactAccessGrantsListInputV1Schema.extend({
  principal: PrincipalRefV1Schema,
}).strict();
export type ArtifactAccessGrantsListInputV1 = z.infer<typeof ArtifactAccessGrantsListInputV1Schema>;
export type ArtifactAccessGrantSetInputV1 = z.infer<typeof ArtifactAccessGrantSetInputV1Schema>;
export type ArtifactAccessGrantRemoveInputV1 = z.infer<typeof ArtifactAccessGrantRemoveInputV1Schema>;

export const ArtifactAccessGrantRowV1Schema = z.object({
  principal: PrincipalRefV1Schema,
  accessLevel: ArtifactAccessLevelV1Schema,
  createdByAccountId: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  display: z.object({ name: z.string().nullable(), username: z.string().nullable().optional() }).strict(),
}).strict();
export type ArtifactAccessGrantRowV1 = z.infer<typeof ArtifactAccessGrantRowV1Schema>;

export const ArtifactAccessGrantsListResponseV1Schema = z.object({
  artifactId: z.string().min(1),
  ownerAccountId: z.string().min(1),
  access: ArtifactCallerAccessV1Schema,
  grants: z.array(ArtifactAccessGrantRowV1Schema),
}).strict();
export const ArtifactAccessGrantMutationResponseV1Schema = ArtifactAccessGrantsListResponseV1Schema.extend({
  access: ArtifactCallerAccessV1Schema.nullable(),
  changed: z.boolean(),
}).strict().refine((response) => response.access !== null || response.grants.length === 0, {
  message: 'A revoked caller cannot receive the grant roster', path: ['grants'],
});
export type ArtifactAccessGrantsListResponseV1 = z.infer<typeof ArtifactAccessGrantsListResponseV1Schema>;
export type ArtifactAccessGrantMutationResponseV1 = z.infer<typeof ArtifactAccessGrantMutationResponseV1Schema>;

export const ArtifactAccessActionInputSchemasV1 = {
  'artifact.access.grants.list': ArtifactAccessGrantsListInputV1Schema,
  'artifact.access.grants.set': ArtifactAccessGrantSetInputV1Schema,
  'artifact.access.grants.remove': ArtifactAccessGrantRemoveInputV1Schema,
} as const;
export const ArtifactAccessActionOutputSchemasV1 = {
  'artifact.access.grants.list': ArtifactAccessGrantsListResponseV1Schema,
  'artifact.access.grants.set': ArtifactAccessGrantMutationResponseV1Schema,
  'artifact.access.grants.remove': ArtifactAccessGrantMutationResponseV1Schema,
} as const;

export const ArtifactRecipientKeyEnvelopeInputV1Schema = z.object({
  recipientAccountId: z.string().min(1),
  encryptedDataKey: SessionDataKeyEnvelopeBytesV1Schema,
  encryptedProvenanceDataKey: SessionDataKeyEnvelopeBytesV1Schema.optional(),
  recipientContentPublicKeyFingerprint: ContentPublicKeyFingerprintSchema,
}).strict();
export type ArtifactRecipientKeyEnvelopeInputV1 = z.infer<typeof ArtifactRecipientKeyEnvelopeInputV1Schema>;
export const ArtifactRecipientKeyEnvelopesV1Schema = z.array(ArtifactRecipientKeyEnvelopeInputV1Schema).refine(
  (items) => new Set(items.map((item) => item.recipientAccountId)).size === items.length,
  { message: 'Duplicate recipientAccountId' },
);

/** Grant writes are semantic; prepared keys use only the fenced envelope commit owner. */
export const ArtifactAccessGrantSetStorageInputV1Schema = ArtifactAccessGrantSetInputV1Schema;
export type ArtifactAccessGrantSetStorageInputV1 = z.infer<typeof ArtifactAccessGrantSetStorageInputV1Schema>;

export const ArtifactAccessRecipientCensusResponseV1Schema = z.object({
  artifactId: z.string().min(1),
  ownerAccountId: z.string().min(1),
  encryptionMode: AccountEncryptionModeSchema,
  access: ArtifactCallerAccessV1Schema,
  /** Owner-column envelope bytes: a commit compares these before preparing the current audience. */
  dataEncryptionKey: SessionDataKeyEnvelopeBytesV1Schema.nullable(),
  /** Exact caller envelope used to open the key; prevents preparing a stale key under a new owner token. */
  callerDataEncryptionKey: SessionDataKeyEnvelopeBytesV1Schema.nullable(),
  provenanceDataEncryptionKey: SessionDataKeyEnvelopeBytesV1Schema.nullable().optional(),
  callerProvenanceDataEncryptionKey: SessionDataKeyEnvelopeBytesV1Schema.nullable().optional(),
  recipients: z.array(z.object({
    recipientAccountId: z.string().min(1),
    contentKey: SessionDataKeyRecipientContentKeyV1Schema,
    contentPublicKeyFingerprint: ContentPublicKeyFingerprintSchema.nullable(),
    encryptedDataKey: SessionDataKeyEnvelopeBytesV1Schema.nullable(),
    encryptedProvenanceDataKey: SessionDataKeyEnvelopeBytesV1Schema.nullable().optional(),
    recipientContentPublicKeyFingerprint: ContentPublicKeyFingerprintSchema.nullable(),
  }).strict()),
}).strict();
export type ArtifactAccessRecipientCensusResponseV1 = z.infer<typeof ArtifactAccessRecipientCensusResponseV1Schema>;

export const ArtifactRecipientKeyEnvelopeCommitInputV1Schema = ArtifactAccessGrantsListInputV1Schema.extend({
  expectedDataEncryptionKey: SessionDataKeyEnvelopeBytesV1Schema,
  expectedProvenanceDataEncryptionKey: SessionDataKeyEnvelopeBytesV1Schema.nullable().optional(),
  recipientKeyEnvelopes: ArtifactRecipientKeyEnvelopesV1Schema,
}).strict();
export type ArtifactRecipientKeyEnvelopeCommitInputV1 = z.infer<typeof ArtifactRecipientKeyEnvelopeCommitInputV1Schema>;
export const ArtifactRecipientKeyEnvelopeCommitResponseV1Schema = z.object({
  appliedRecipientAccountIds: z.array(z.string().min(1)),
  skippedRecipientAccountIds: z.array(z.string().min(1)),
}).strict();
export type ArtifactRecipientKeyEnvelopeCommitResponseV1 = z.infer<typeof ArtifactRecipientKeyEnvelopeCommitResponseV1Schema>;

export const ArtifactAccessErrorCodeV1Schema = z.enum([
  'artifact_not_found', 'artifact_access_forbidden', 'artifact_kind_not_shareable',
  'artifact_content_unavailable', 'artifact_invalid_recipient_envelope', 'artifact_data_key_changed',
  'artifact_subject_not_found', 'artifact_subject_ineligible', 'artifact_owner_grant_invalid',
  'data_key_not_required', 'recipient_key_unavailable',
  'artifact_access_unavailable', 'artifact_access_failed',
]);
export type ArtifactAccessErrorCodeV1 = z.infer<typeof ArtifactAccessErrorCodeV1Schema>;
