import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { ArtifactCallerAccessV1Schema } from './artifactAccessV1.js';
import { StoredContentPublicShareAccessLogResponseV1Schema, StoredContentPublicShareCreateRequestV1Schema, StoredContentPublicShareV1Schema, StoredContentPublicSharesListResponseV1Schema } from '../sharing/storedContentPublicShareV1.js';
import { ArtifactBodyV1Schema, ArtifactRevisionProvenanceV1Schema } from './artifactBinaryV1.js';
import { ARTIFACT_ACTION_IDS_V1 } from './artifactActionIdsV1.js';
export { ARTIFACT_ACTION_IDS_V1 } from './artifactActionIdsV1.js';
import { ArtifactRevisionV1Schema } from './artifactRevisionV1.js';
import { ArtifactWorkspacePublicationSourceV1Schema } from './artifactWorkspaceFileV1.js';
import { UiSurfaceCapabilityRequestV1Schema } from '../plugins/contributions/ui/hostedHtmlCapabilitiesV1.js';
import { RoleArtifactV1Schema } from '../prompts/roles/roleArtifactV1.js';
import { LaunchProfileArtifactV1Schema } from '../launchProfiles/launchProfileArtifactV1.js';
export { ArtifactRevisionV1Schema, type ArtifactRevisionV1 } from './artifactRevisionV1.js';

export const ArtifactActionIdV1Schema = lazyZodSchema(() => z.enum(ARTIFACT_ACTION_IDS_V1));
export type ArtifactActionIdV1 = z.infer<typeof ArtifactActionIdV1Schema>;

/** Authenticated read fact: omitted or unfamiliar values never establish privacy. */
export const ArtifactPublicAudienceV1ReadSchema = lazyZodSchema(() => z.catch(z._default(z.optional(z.enum(['retained', 'none', 'unknown'])), 'unknown'), 'unknown'));
export type ArtifactPublicAudienceV1 = z.output<typeof ArtifactPublicAudienceV1ReadSchema>;
// Headers belong to their content-kind owners. Preserve JSON metadata; it never supplies authority.
export const ArtifactHeaderMetadataV1Schema = lazyZodSchema(() => z.record(z.string(), StrictJsonValueSchema));

const subject = z.strictObject({ artifactId: z.string().check(z.minLength(1)) });
const acknowledgement = (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(subject, { revision: ArtifactRevisionV1Schema }));
export const ArtifactPublicLinkCreateInputV1Schema = (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(subject, lazyZodSchema(() => z.pick(StoredContentPublicShareCreateRequestV1Schema, {
  expiresAt: true, maxUses: true, isConsentRequired: true,
})).shape));
export const ArtifactPublicLinkRevokeInputV1Schema = (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(subject, { shareId: z.string().check(z.minLength(1)) }));
const upload = { uploadPath: z.string().check(z.minLength(1)), mime: z.optional(z.string().check(z.minLength(1))) };
export const ArtifactCreateInputV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ artifactId: z.optional(z.string().check(z.uuid())), header: ArtifactHeaderMetadataV1Schema, body: z.string() }),
  z.strictObject({ artifactId: z.optional(z.string().check(z.uuid())), header: ArtifactHeaderMetadataV1Schema, ...upload }),
]));
export const ArtifactListInputV1Schema = lazyZodSchema(() => z.strictObject({
  search: z.optional(z.string()), kind: z.optional(z.string().check(z.minLength(1))),
  sort: z.optional(z.enum(['updated_desc', 'created_desc', 'title_asc'])),
  limit: z.optional(z.number().check(z.int(), z.positive())), cursor: z.optional(z.string().check(z.minLength(1))),
}));
export const ArtifactUpdateInputV1Schema = lazyZodSchema(() => z.union([
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(subject, { expectedRevision: ArtifactRevisionV1Schema, header: ArtifactHeaderMetadataV1Schema, body: z.string() })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(subject, { expectedRevision: ArtifactRevisionV1Schema, header: ArtifactHeaderMetadataV1Schema, ...upload })),
]));
export const ArtifactDeleteInputV1Schema = (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(subject, { expectedRevision: ArtifactRevisionV1Schema }));
export const ArtifactExportInputV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ...subject.shape, path: z.string().check(z.minLength(1)), overwrite: z.optional(z.boolean()) }),
  z.strictObject({ portable: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('role'), document: RoleArtifactV1Schema }),
    z.strictObject({ kind: z.literal('launch-profile'), document: LaunchProfileArtifactV1Schema }),
  ]) }),
]));
export const ArtifactPublishFromFileInputV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ArtifactWorkspacePublicationSourceV1Schema, {
  title: z.optional(z.string()), mime: z.optional(z.string().check(z.minLength(1))), kind: z.optional(z.string().check(z.minLength(1))),
  requestedCapabilities: z.optional(UiSurfaceCapabilityRequestV1Schema),
})));
export const ArtifactRestoreInputV1Schema = (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(subject, {
  bodyVersion: z.number().check(z.int(), z.positive()), expectedRevision: ArtifactRevisionV1Schema,
}));
export const ArtifactHeaderV1Schema = (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(subject, {
  ownerAccountId: z.string().check(z.minLength(1)), access: ArtifactCallerAccessV1Schema,
  publicAudience: ArtifactPublicAudienceV1ReadSchema,
  header: ArtifactHeaderMetadataV1Schema, headerVersion: z.number().check(z.int(), z.positive()),
  seq: z.number().check(z.int(), z.nonnegative()), createdAt: z.number().check(z.int(), z.nonnegative()), updatedAt: z.number().check(z.int(), z.nonnegative()),
}));

/** Project admitted native document rows onto the ordinary Action's strict header DTO. */
export function projectArtifactHeaderV1(value: unknown): z.output<typeof ArtifactHeaderV1Schema> {
  return (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: undefined }) as z.ZodMiniObject<T['shape'], z.core.$strip>)(ArtifactHeaderV1Schema).parse(value);
}
export const ArtifactDocumentV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(ArtifactHeaderV1Schema, { headerVersion: true }), {
  body: z.nullable(ArtifactBodyV1Schema), revision: ArtifactRevisionV1Schema,
  provenance: z.optional(ArtifactRevisionProvenanceV1Schema),
  /** Diagnostic projection from an admitted current audience, not caller authority. */
  shared: z.optional(z.boolean()),
})));
export const ArtifactQuotaExceededV1Schema = lazyZodSchema(() => z.strictObject({
  error: z.literal('quota_exceeded'), budget: z.enum(['document', 'account']),
  limitBytes: z.number().check(z.int(), z.nonnegative()), usedBytes: z.number().check(z.int(), z.nonnegative()),
}));
export type ArtifactQuotaExceededV1 = z.infer<typeof ArtifactQuotaExceededV1Schema>;
export const ArtifactStorageUsageV1Schema = lazyZodSchema(() => z.strictObject({
  usedBytes: z.number().check(z.int(), z.nonnegative()), limitBytes: z.nullable(z.number().check(z.int(), z.nonnegative())),
  documentLimitBytes: z.nullable(z.number().check(z.int(), z.nonnegative())), revisionRetentionCount: z.number().check(z.int(), z.nonnegative()),
}));
export type ArtifactStorageUsageV1 = z.infer<typeof ArtifactStorageUsageV1Schema>;
export const ArtifactStoredBodyRevisionV1Schema = lazyZodSchema(() => z.strictObject({
  bodyVersion: z.number().check(z.int(), z.positive()), body: z.string(), createdAt: z.number().check(z.int(), z.nonnegative()),
  sizeBytes: z.number().check(z.int(), z.nonnegative()),
  provenance: z.optional(z.nullable(z.string())),
}));
export const ArtifactRevisionListResponseV1Schema = lazyZodSchema(() => z.strictObject({
  revisions: z.array(ArtifactStoredBodyRevisionV1Schema), retentionCount: z.number().check(z.int(), z.nonnegative()),
}));
export const ArtifactBodyRevisionV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ArtifactStoredBodyRevisionV1Schema, {
  body: z.nullable(ArtifactBodyV1Schema), provenance: z.optional(ArtifactRevisionProvenanceV1Schema),
})));

export const ArtifactActionInputSchemasV1 = {
  'artifact.create': ArtifactCreateInputV1Schema,
  'artifact.get': subject,
  'artifact.export': ArtifactExportInputV1Schema,
  'artifact.list': ArtifactListInputV1Schema,
  'artifact.update': ArtifactUpdateInputV1Schema,
  'artifact.delete': ArtifactDeleteInputV1Schema,
  'artifact.publish_from_file': ArtifactPublishFromFileInputV1Schema,
  'artifact.revisions.list': subject,
  'artifact.revisions.restore': ArtifactRestoreInputV1Schema,
  'artifact.storage.usage': z.strictObject({}),
  'artifact.public_link.create': ArtifactPublicLinkCreateInputV1Schema,
  'artifact.public_link.list': subject,
  'artifact.public_link.revoke': ArtifactPublicLinkRevokeInputV1Schema,
  'artifact.public_link.audit': ArtifactPublicLinkRevokeInputV1Schema,
} as const;
export const ArtifactActionOutputSchemasV1 = {
  'artifact.create': acknowledgement,
  'artifact.get': z.strictObject({ artifact: z.nullable(ArtifactDocumentV1Schema) }),
  'artifact.export': lazyZodSchema(() => z.union([
    z.strictObject({ ...subject.shape, path: z.string().check(z.minLength(1)), sizeBytes: z.number().check(z.int(), z.nonnegative()) }),
    z.strictObject({ exported: z.literal(true), fileName: z.string().check(z.minLength(1)) }),
  ])),
  'artifact.list': z.strictObject({ items: z.array(ArtifactHeaderV1Schema), nextCursor: z.optional(z.string().check(z.minLength(1))) }),
  'artifact.update': acknowledgement,
  'artifact.delete': (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(subject, { deleted: z.literal(true) })),
  'artifact.publish_from_file': acknowledgement,
  'artifact.revisions.list': (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(subject, { revisions: z.array(ArtifactBodyRevisionV1Schema), retentionCount: z.number().check(z.int(), z.nonnegative()) })),
  'artifact.revisions.restore': acknowledgement,
  'artifact.storage.usage': ArtifactStorageUsageV1Schema,
  'artifact.public_link.create': z.strictObject({ publicShare: StoredContentPublicShareV1Schema, url: z.string().check(z.url()) }),
  'artifact.public_link.list': StoredContentPublicSharesListResponseV1Schema,
  'artifact.public_link.revoke': (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(subject, { shareId: z.string().check(z.minLength(1)), revoked: z.literal(true) })),
  'artifact.public_link.audit': StoredContentPublicShareAccessLogResponseV1Schema,
} as const;
export type ArtifactActionInputV1<T extends ArtifactActionIdV1> = z.input<(typeof ArtifactActionInputSchemasV1)[T]>;
export type ArtifactActionResultV1<T extends ArtifactActionIdV1> = z.output<(typeof ArtifactActionOutputSchemasV1)[T]>;
