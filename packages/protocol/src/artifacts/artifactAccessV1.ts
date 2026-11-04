import { BotTemplateVersionV1Schema } from '../bots/templates/templateVersionV1.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { ArtifactCoarseKindV1Schema } from './artifactKindV1.js';

import { PrincipalRefV1Schema } from '../teams/principal.js';
import { AccountEncryptionModeSchema } from '../features/payload/capabilities/encryptionCapabilities.js';
import { ResourceAccessLevelV1Schema, ResourceCallerAccessV1Schema, ResourceAccessGrantRowV1Schema,
  ResourceRecipientKeyEnvelopeInputV1Schema, ResourceRecipientCensusRowV1Schema,
  ResourceRecipientKeyEnvelopeCommitResponseV1Schema, ResourceRecipientKeyEnvelopeCommitInputV1Schema,
  ResourceAccessRecipientCensusV1Schema, resourceRecipientAccountIdsAreUnique } from '../teams/resourceGrantAccessV1.js';
import {
  SessionDataKeyEnvelopeBytesV1Schema,
} from '../sessions/encryption/sessionDataKeyEnvelopes.js';

/** Document grant wire epoch V1. Every identity, mutation and nested object is closed. */
export const ARTIFACT_ACCESS_ACTION_IDS_V1 = [
  'artifact.access.grants.list', 'artifact.access.grants.set', 'artifact.access.grants.remove',
] as const;
export const ArtifactAccessActionIdV1Schema = lazyZodSchema(() => z.enum(ARTIFACT_ACCESS_ACTION_IDS_V1));
export type ArtifactAccessActionIdV1 = z.infer<typeof ArtifactAccessActionIdV1Schema>;

export const ArtifactAccessLevelV1Schema = ResourceAccessLevelV1Schema;
export type ArtifactAccessLevelV1 = z.infer<typeof ArtifactAccessLevelV1Schema>;
export const ArtifactCallerAccessV1Schema = ResourceCallerAccessV1Schema;
export type ArtifactCallerAccessV1 = z.infer<typeof ArtifactCallerAccessV1Schema>;

export const ArtifactAccessGrantsListInputV1Schema = lazyZodSchema(() => z.strictObject({ artifactId: z.string().check(z.minLength(1)) }));
export const ArtifactAccessGrantSetInputV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ArtifactAccessGrantsListInputV1Schema, {
  principal: PrincipalRefV1Schema,
  accessLevel: ArtifactAccessLevelV1Schema,
})));
export const ArtifactAccessGrantRemoveInputV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ArtifactAccessGrantsListInputV1Schema, {
  principal: PrincipalRefV1Schema,
})));
export type ArtifactAccessGrantsListInputV1 = z.infer<typeof ArtifactAccessGrantsListInputV1Schema>;
export type ArtifactAccessGrantSetInputV1 = z.infer<typeof ArtifactAccessGrantSetInputV1Schema>;
export type ArtifactAccessGrantRemoveInputV1 = z.infer<typeof ArtifactAccessGrantRemoveInputV1Schema>;

export const ArtifactTemplateAcceptedVersionInputV1Schema = lazyZodSchema(() => z.strictObject({
  artifactId: z.string().check(z.minLength(1)),
  /** Existing recipient Session/creation identity; never projected to the template owner. */
  copyId: z.string().check(z.minLength(1)),
  acceptedVersion: BotTemplateVersionV1Schema,
}));
export type ArtifactTemplateAcceptedVersionInputV1 = z.infer<typeof ArtifactTemplateAcceptedVersionInputV1Schema>;
export const ArtifactTemplateAcceptedVersionResponseV1Schema = lazyZodSchema(() => z.strictObject({ changed: z.boolean() }));
export const ArtifactTemplateAcceptedVersionSummaryV1Schema = lazyZodSchema(() => z.strictObject({
  version: BotTemplateVersionV1Schema,
  copies: z.number().check(z.int(), z.minimum(1)),
  reportedAt: z.number().check(z.int(), z.nonnegative()),
}));
export const ArtifactAccessGrantRowV1Schema = lazyZodSchema(() => z.extend(ResourceAccessGrantRowV1Schema, {
  /** Owner-only direct Account reports; absent on other kinds or self-only recipient projections. */
  acceptedVersions: z.optional(z.array(ArtifactTemplateAcceptedVersionSummaryV1Schema)),
}));
export type ArtifactAccessGrantRowV1 = z.infer<typeof ArtifactAccessGrantRowV1Schema>;

export const ArtifactAccessGrantsListResponseV1Schema = lazyZodSchema(() => z.strictObject({
  artifactId: z.string().check(z.minLength(1)),
  ownerAccountId: z.string().check(z.minLength(1)),
  access: ArtifactCallerAccessV1Schema,
  grants: z.array(ArtifactAccessGrantRowV1Schema),
}));
export const ArtifactAccessGrantMutationResponseV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ArtifactAccessGrantsListResponseV1Schema, {
  access: z.nullable(ArtifactCallerAccessV1Schema),
  changed: z.boolean(),
  /** The grant receipt is committed; a fresh Artifact read retries key preparation. */
  preparation: z.optional(z.strictObject({ status: z.literal('pending') })),
})).check(z.refine((response) => response.access !== null || response.grants.length === 0, {
  message: 'A revoked caller cannot receive the grant roster', path: ['grants'],
})));
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

export const ArtifactRecipientKeyEnvelopeInputV1Schema = lazyZodSchema(() => z.extend(ResourceRecipientKeyEnvelopeInputV1Schema, {
  encryptedProvenanceDataKey: z.optional(SessionDataKeyEnvelopeBytesV1Schema),
}));
export type ArtifactRecipientKeyEnvelopeInputV1 = z.infer<typeof ArtifactRecipientKeyEnvelopeInputV1Schema>;
export const ArtifactRecipientKeyEnvelopesV1Schema = lazyZodSchema(() => z.array(ArtifactRecipientKeyEnvelopeInputV1Schema).check(z.refine(resourceRecipientAccountIdsAreUnique, { message: 'Duplicate recipientAccountId' })));

/** Grant writes are semantic; prepared keys use only the fenced envelope commit owner. */
export const ArtifactAccessGrantSetStorageInputV1Schema = ArtifactAccessGrantSetInputV1Schema;
export type ArtifactAccessGrantSetStorageInputV1 = z.infer<typeof ArtifactAccessGrantSetStorageInputV1Schema>;

export const ArtifactAccessRecipientCensusResponseV1Schema = lazyZodSchema(() => z.extend(ResourceAccessRecipientCensusV1Schema, {
  artifactId: z.string().check(z.minLength(1)),
  provenanceDataEncryptionKey: z.optional(z.nullable(SessionDataKeyEnvelopeBytesV1Schema)),
  callerProvenanceDataEncryptionKey: z.optional(z.nullable(SessionDataKeyEnvelopeBytesV1Schema)),
  recipients: z.array(z.extend(ResourceRecipientCensusRowV1Schema, {
    encryptedProvenanceDataKey: z.optional(z.nullable(SessionDataKeyEnvelopeBytesV1Schema)),
  })),
}));
export type ArtifactAccessRecipientCensusResponseV1 = z.infer<typeof ArtifactAccessRecipientCensusResponseV1Schema>;

export const ArtifactRecipientKeyEnvelopeCommitInputV1Schema = lazyZodSchema(() => z.extend(ResourceRecipientKeyEnvelopeCommitInputV1Schema, {
  artifactId: z.string().check(z.minLength(1)),
  expectedProvenanceDataEncryptionKey: z.optional(z.nullable(SessionDataKeyEnvelopeBytesV1Schema)),
  recipientKeyEnvelopes: ArtifactRecipientKeyEnvelopesV1Schema,
}));
export type ArtifactRecipientKeyEnvelopeCommitInputV1 = z.infer<typeof ArtifactRecipientKeyEnvelopeCommitInputV1Schema>;
export const ArtifactRecipientKeyEnvelopeCommitResponseV1Schema = ResourceRecipientKeyEnvelopeCommitResponseV1Schema;
export type ArtifactRecipientKeyEnvelopeCommitResponseV1 = z.infer<typeof ArtifactRecipientKeyEnvelopeCommitResponseV1Schema>;

export const ArtifactAccessErrorCodeV1Schema = lazyZodSchema(() => z.enum([
  'artifact_not_found', 'artifact_access_forbidden', 'artifact_kind_not_shareable',
  'artifact_content_unavailable', 'artifact_invalid_recipient_envelope', 'artifact_data_key_changed',
  'artifact_subject_not_found', 'artifact_subject_ineligible', 'artifact_owner_grant_invalid',
  'data_key_not_required', 'recipient_key_unavailable',
  'artifact_access_unavailable', 'artifact_access_failed',
]));
export type ArtifactAccessErrorCodeV1 = z.infer<typeof ArtifactAccessErrorCodeV1Schema>;

/** Exact authenticated HTTP read, shared by single and selected batch reads. Closed V1 objects;
 * header/body/provenance strings remain opaque content owned by their existing codecs. */
export const ArtifactHttpReadV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.string().check(z.minLength(1)), ownerAccountId: z.string().check(z.minLength(1)), access: ArtifactCallerAccessV1Schema,
  ownerDisplayName: z.optional(z.nullable(z.string())),
  encryptionMode: AccountEncryptionModeSchema,
  kind: z.optional(z.nullable(ArtifactCoarseKindV1Schema)),
  kindHint: z.optional(z.nullable(z.string())),
  header: z.string(), headerVersion: z.number(), body: z.string(), bodyVersion: z.number(),
  publicAudience: z.enum(['retained', 'none']),
  provenance: z.optional(z.nullable(z.string())), provenanceDataEncryptionKey: z.optional(z.nullable(z.string())),
  dataEncryptionKey: z.string(), seq: z.number(), createdAt: z.number(), updatedAt: z.number(),
}));

/** V1 selected read: one result for every requested identity, in request order. */
export const ArtifactReadBatchInputV1Schema = lazyZodSchema(() => z.strictObject({
  artifactIds: z.array(z.string().check(z.minLength(1))).check(z.refine(ids => new Set(ids).size === ids.length, {
    message: 'Duplicate Artifact identity',
  })),
}));
/** Explicit narrow read in the undeployed 0.3 HTTP contract. Full reads retain their V1 shape. */
export const ArtifactReadHeadersBatchInputV1Schema = lazyZodSchema(() => z.strictObject({
  artifactIds: ArtifactReadBatchInputV1Schema.shape.artifactIds,
  projection: z.literal('headers'),
}));
export const ArtifactHttpHeaderReadV1Schema = lazyZodSchema(() => z.omit(ArtifactHttpReadV1Schema, { body: true }));
const ArtifactReadBatchRefusalV1Schema = lazyZodSchema(() => z.strictObject({
  artifactId: z.string().check(z.minLength(1)), ok: z.literal(false), error: ArtifactAccessErrorCodeV1Schema,
  status: z.union([z.literal(400), z.literal(403), z.literal(404), z.literal(409), z.literal(500)]),
  retryable: z.boolean(),
}));
export const ArtifactReadBatchResponseV1Schema = lazyZodSchema(() => z.strictObject({
  items: z.array(z.discriminatedUnion('ok', [
    z.strictObject({ artifactId: z.string().check(z.minLength(1)), ok: z.literal(true), artifact: ArtifactHttpReadV1Schema,
      recipientCensus: z.nullable(ArtifactAccessRecipientCensusResponseV1Schema) }),
    ArtifactReadBatchRefusalV1Schema,
  ])).check(z.refine(items => items.every(item => !item.ok || (item.artifactId === item.artifact.id
    && (item.artifact.encryptionMode === 'plain' ? item.recipientCensus === null
      : item.recipientCensus !== null && item.recipientCensus.artifactId === item.artifactId
        && item.recipientCensus.ownerAccountId === item.artifact.ownerAccountId
        && item.recipientCensus.access === item.artifact.access
        && item.recipientCensus.encryptionMode === item.artifact.encryptionMode))), {
    message: 'Artifact detail and recipient census do not agree',
  })),
}));
export type ArtifactReadBatchResponseV1 = z.infer<typeof ArtifactReadBatchResponseV1Schema>;
export const ArtifactReadHeadersBatchResponseV1Schema = lazyZodSchema(() => z.strictObject({
  projection: z.literal('headers'),
  items: z.array(z.discriminatedUnion('ok', [
    z.strictObject({ artifactId: z.string().check(z.minLength(1)), ok: z.literal(true), artifact: ArtifactHttpHeaderReadV1Schema }),
    ArtifactReadBatchRefusalV1Schema,
  ])).check(z.refine(items => items.every(item => !item.ok || item.artifactId === item.artifact.id), {
    message: 'Artifact header does not match its addressed identity',
  })),
}));
export type ArtifactReadHeadersBatchResponseV1 = z.infer<typeof ArtifactReadHeadersBatchResponseV1Schema>;
export const ArtifactReadBatchHttpInputV1Schema = lazyZodSchema(() => z.union([
  ArtifactReadBatchInputV1Schema, ArtifactReadHeadersBatchInputV1Schema,
]));
export const ArtifactReadBatchHttpResponseV1Schema = lazyZodSchema(() => z.union([
  ArtifactReadBatchResponseV1Schema, ArtifactReadHeadersBatchResponseV1Schema,
]));
