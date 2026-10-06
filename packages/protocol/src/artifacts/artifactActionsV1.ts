import { z } from 'zod';

import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { ArtifactCallerAccessV1Schema } from './artifactAccessV1.js';
import { StoredContentPublicShareAccessLogResponseV1Schema, StoredContentPublicShareCreateRequestV1Schema, StoredContentPublicShareV1Schema, StoredContentPublicSharesListResponseV1Schema } from '../sharing/storedContentPublicShareV1.js';
import { ArtifactBodyV1Schema, ArtifactRevisionProvenanceV1Schema } from './artifactBinaryV1.js';

/** Ordinary Artifact Action wire epoch V1. Mutation and identity objects are closed. */
export const ARTIFACT_ACTION_IDS_V1 = [
  'artifact.create', 'artifact.get', 'artifact.list', 'artifact.update', 'artifact.delete',
  'artifact.publish_from_file', 'artifact.revisions.list', 'artifact.revisions.restore', 'artifact.storage.usage',
  'artifact.public_link.create', 'artifact.public_link.list', 'artifact.public_link.revoke', 'artifact.public_link.audit',
] as const;
export const ArtifactActionIdV1Schema = z.enum(ARTIFACT_ACTION_IDS_V1);
export type ArtifactActionIdV1 = z.infer<typeof ArtifactActionIdV1Schema>;

export const ArtifactRevisionV1Schema = z.object({
  headerVersion: z.number().int().positive(), bodyVersion: z.number().int().positive(),
}).strict();
export type ArtifactRevisionV1 = z.infer<typeof ArtifactRevisionV1Schema>;
// Headers belong to their content-kind owners. Preserve JSON metadata; it never supplies authority.
export const ArtifactHeaderMetadataV1Schema = z.record(z.string(), StrictJsonValueSchema);

const subject = z.object({ artifactId: z.string().min(1) }).strict();
const htmlPreview = {
  previewUrl: z.string().url().optional(),
  previewError: z.literal('artifact_html_preview_unavailable').optional(),
};
const acknowledgement = subject.extend({ revision: ArtifactRevisionV1Schema, ...htmlPreview }).strict();
export const ArtifactPublicLinkCreateInputV1Schema = subject.extend(StoredContentPublicShareCreateRequestV1Schema.pick({
  expiresAt: true, maxUses: true, isConsentRequired: true,
}).shape).strict();
export const ArtifactPublicLinkRevokeInputV1Schema = subject.extend({ shareId: z.string().min(1) }).strict();
const upload = { uploadPath: z.string().min(1), mime: z.string().min(1).optional() };
export const ArtifactCreateInputV1Schema = z.union([
  z.object({ artifactId: z.string().uuid().optional(), header: ArtifactHeaderMetadataV1Schema, body: z.string() }).strict(),
  z.object({ artifactId: z.string().uuid().optional(), header: ArtifactHeaderMetadataV1Schema, ...upload }).strict(),
]);
export const ArtifactListInputV1Schema = z.object({
  search: z.string().optional(), kind: z.string().min(1).optional(),
  sort: z.enum(['updated_desc', 'created_desc', 'title_asc']).optional(),
  limit: z.number().int().positive().optional(), cursor: z.string().min(1).optional(),
}).strict();
export const ArtifactUpdateInputV1Schema = z.union([
  subject.extend({ expectedRevision: ArtifactRevisionV1Schema, header: ArtifactHeaderMetadataV1Schema, body: z.string() }).strict(),
  subject.extend({ expectedRevision: ArtifactRevisionV1Schema, header: ArtifactHeaderMetadataV1Schema, ...upload }).strict(),
]);
export const ArtifactDeleteInputV1Schema = subject.extend({ expectedRevision: ArtifactRevisionV1Schema }).strict();
export const ArtifactPublishFromFileInputV1Schema = z.object({
  path: z.string().min(1), title: z.string().optional(), mime: z.string().min(1).optional(), kind: z.string().min(1).optional(),
}).strict();
export const ArtifactRestoreInputV1Schema = subject.extend({
  bodyVersion: z.number().int().positive(), expectedRevision: ArtifactRevisionV1Schema,
}).strict();
export const ArtifactHeaderV1Schema = subject.extend({
  ownerAccountId: z.string().min(1), access: ArtifactCallerAccessV1Schema,
  header: ArtifactHeaderMetadataV1Schema, headerVersion: z.number().int().positive(),
  seq: z.number().int().nonnegative(), createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
}).strict();
export const ArtifactDocumentV1Schema = ArtifactHeaderV1Schema.omit({ headerVersion: true }).extend({
  body: ArtifactBodyV1Schema.nullable(), revision: ArtifactRevisionV1Schema,
  provenance: ArtifactRevisionProvenanceV1Schema.optional(),
}).strict();
export const ArtifactQuotaExceededV1Schema = z.object({
  error: z.literal('quota_exceeded'), budget: z.enum(['document', 'account']),
  limitBytes: z.number().int().nonnegative(), usedBytes: z.number().int().nonnegative(),
}).strict();
export type ArtifactQuotaExceededV1 = z.infer<typeof ArtifactQuotaExceededV1Schema>;
export const ArtifactStorageUsageV1Schema = z.object({
  usedBytes: z.number().int().nonnegative(), limitBytes: z.number().int().nonnegative().nullable(),
  documentLimitBytes: z.number().int().nonnegative().nullable(), revisionRetentionCount: z.number().int().nonnegative(),
}).strict();
export type ArtifactStorageUsageV1 = z.infer<typeof ArtifactStorageUsageV1Schema>;
export const ArtifactStoredBodyRevisionV1Schema = z.object({
  bodyVersion: z.number().int().positive(), body: z.string(), createdAt: z.number().int().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
  provenance: z.string().nullable().optional(),
}).strict();
export const ArtifactRevisionListResponseV1Schema = z.object({
  revisions: z.array(ArtifactStoredBodyRevisionV1Schema), retentionCount: z.number().int().nonnegative(),
}).strict();
export const ArtifactBodyRevisionV1Schema = ArtifactStoredBodyRevisionV1Schema.extend({
  body: ArtifactBodyV1Schema.nullable(), provenance: ArtifactRevisionProvenanceV1Schema.optional(),
}).strict();

export const ArtifactActionInputSchemasV1 = {
  'artifact.create': ArtifactCreateInputV1Schema,
  'artifact.get': subject,
  'artifact.list': ArtifactListInputV1Schema,
  'artifact.update': ArtifactUpdateInputV1Schema,
  'artifact.delete': ArtifactDeleteInputV1Schema,
  'artifact.publish_from_file': ArtifactPublishFromFileInputV1Schema,
  'artifact.revisions.list': subject,
  'artifact.revisions.restore': ArtifactRestoreInputV1Schema,
  'artifact.storage.usage': z.object({}).strict(),
  'artifact.public_link.create': ArtifactPublicLinkCreateInputV1Schema,
  'artifact.public_link.list': subject,
  'artifact.public_link.revoke': ArtifactPublicLinkRevokeInputV1Schema,
  'artifact.public_link.audit': ArtifactPublicLinkRevokeInputV1Schema,
} as const;
export const ArtifactActionOutputSchemasV1 = {
  'artifact.create': acknowledgement,
  'artifact.get': z.object({ artifact: ArtifactDocumentV1Schema.nullable(), ...htmlPreview }).strict(),
  'artifact.list': z.object({ items: z.array(ArtifactHeaderV1Schema), nextCursor: z.string().min(1).optional() }).strict(),
  'artifact.update': acknowledgement,
  'artifact.delete': subject.extend({ deleted: z.literal(true) }).strict(),
  'artifact.publish_from_file': acknowledgement,
  'artifact.revisions.list': subject.extend({ revisions: z.array(ArtifactBodyRevisionV1Schema), retentionCount: z.number().int().nonnegative() }).strict(),
  'artifact.revisions.restore': acknowledgement,
  'artifact.storage.usage': ArtifactStorageUsageV1Schema,
  'artifact.public_link.create': z.object({ publicShare: StoredContentPublicShareV1Schema, url: z.string().url() }).strict(),
  'artifact.public_link.list': StoredContentPublicSharesListResponseV1Schema,
  'artifact.public_link.revoke': subject.extend({ shareId: z.string().min(1), revoked: z.literal(true) }).strict(),
  'artifact.public_link.audit': StoredContentPublicShareAccessLogResponseV1Schema,
} as const;
export type ArtifactActionInputV1<T extends ArtifactActionIdV1> = z.input<(typeof ArtifactActionInputSchemasV1)[T]>;
export type ArtifactActionResultV1<T extends ArtifactActionIdV1> = z.output<(typeof ArtifactActionOutputSchemasV1)[T]>;
