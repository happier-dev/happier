import { z } from 'zod';

import { StrictJsonValueSchema } from '../../../json/strictJsonValue.js';
import {
  addRegisteredSessionSystemRecordKindIssue,
  addSessionSystemRecordPlainContentPayloadIssue,
} from './sessionSystemRecordCatalog.js';
import { SessionSystemRecordAddressSchema, SessionSystemRecordLocalIdSchema } from './sessionSystemRecordAddress.js';
import { SessionSystemRecordContentSchema } from './sessionSystemRecordContent.js';
import { SessionSystemRecordKindSchema } from './sessionSystemRecordKind.js';
import { SessionSystemRecordNamespaceSchema } from './sessionSystemRecordNamespace.js';
import { SessionSystemRecordSchema } from './sessionSystemRecord.js';
import { SessionSystemRecordRevisionSchema } from './sessionSystemRecordRevision.js';
import {
  SessionPermissionMediationRecordIdentityV1Schema,
  SESSION_PERMISSION_SYSTEM_RECORD_KINDS,
} from '../../permissions/mediationRecordsV1.js';

const SessionSystemRecordCursorSchema = z.string().trim().min(1).nullable().optional();
const SessionSystemRecordLimitSchema = z.coerce.number().int().min(1).max(500).default(100);

// Released/predecessor host records accepted trimmed, otherwise-unbounded local ids.
// Keep this seam distinct from the strict author-v1 address schema.
export const LegacyHostSessionSystemRecordLocalIdSchema = z.string().trim().min(1);

export const SessionSystemRecordUpsertRequestSchema = z.object({
  address: SessionSystemRecordAddressSchema,
  content: StrictJsonValueSchema,
  expectedRevision: SessionSystemRecordRevisionSchema.nullable().optional(),
}).strict();
export type SessionSystemRecordUpsertRequest = z.infer<typeof SessionSystemRecordUpsertRequestSchema>;

export const SessionSystemRecordReadRequestSchema = z.object({
  address: SessionSystemRecordAddressSchema,
}).strict();
export type SessionSystemRecordReadRequest = z.infer<typeof SessionSystemRecordReadRequestSchema>;

export const SessionSystemRecordDeleteRequestSchema = z.object({
  address: SessionSystemRecordAddressSchema,
  expectedRevision: SessionSystemRecordRevisionSchema.optional(),
}).strict();
export type SessionSystemRecordDeleteRequest = z.infer<typeof SessionSystemRecordDeleteRequestSchema>;

export const SessionSystemRecordDeleteResponseSchema = z.object({ ok: z.literal(true) }).strict();
export type SessionSystemRecordDeleteResponse = z.infer<typeof SessionSystemRecordDeleteResponseSchema>;

export const SessionSystemRecordListQuerySchema = z.discriminatedUnion('owner', [
  z.object({
    owner: z.literal('plugin'),
    namespace: SessionSystemRecordAddressSchema.options[0].shape.namespace,
    kind: SessionSystemRecordAddressSchema.options[0].shape.kind.optional(),
    localId: SessionSystemRecordLocalIdSchema.optional(),
    limit: SessionSystemRecordLimitSchema,
    cursor: SessionSystemRecordCursorSchema,
  }).strict(),
  z.object({
    owner: z.literal('host'),
    namespace: SessionSystemRecordNamespaceSchema,
    kind: SessionSystemRecordKindSchema.optional(),
    localId: SessionSystemRecordLocalIdSchema.optional(),
    limit: SessionSystemRecordLimitSchema,
    cursor: SessionSystemRecordCursorSchema,
  }).strict(),
]);
export type SessionSystemRecordListQuery = z.infer<typeof SessionSystemRecordListQuerySchema>;

export const SessionSystemRecordPageSchema = z.object({
  records: z.array(SessionSystemRecordSchema),
  nextCursor: z.string().trim().min(1).nullable(),
  hasNext: z.boolean(),
}).strict();
export type SessionSystemRecordPage = z.infer<typeof SessionSystemRecordPageSchema>;

export const SessionSystemRecordUpsertResponseSchema = z.object({ record: SessionSystemRecordSchema }).strict();
export type SessionSystemRecordUpsertResponse = z.infer<typeof SessionSystemRecordUpsertResponseSchema>;
export const SessionSystemRecordReadResponseSchema = z.object({ record: SessionSystemRecordSchema.nullable() }).strict();
export type SessionSystemRecordReadResponse = z.infer<typeof SessionSystemRecordReadResponseSchema>;
export const SessionSystemRecordPageResponseSchema = SessionSystemRecordPageSchema;
export type SessionSystemRecordPageResponse = SessionSystemRecordPage;

// Host-internal transport DTOs. Public SessionHandle calls carry opened JSON;
// the CLI seals once and sends this stored envelope to the canonical server owner.
export const SessionSystemRecordStoredSchema = SessionSystemRecordSchema.extend({
  content: SessionSystemRecordContentSchema,
}).strict();
export type SessionSystemRecordStored = z.infer<typeof SessionSystemRecordStoredSchema>;
export const SessionSystemRecordStoredUpsertRequestSchema = z.object({
  address: SessionSystemRecordAddressSchema,
  content: SessionSystemRecordContentSchema,
  expectedRevision: SessionSystemRecordRevisionSchema.nullable().optional(),
}).strict();
export type SessionSystemRecordStoredUpsertRequest = z.infer<typeof SessionSystemRecordStoredUpsertRequestSchema>;
export const SessionSystemRecordStoredUpsertResponseSchema = z.object({ record: SessionSystemRecordStoredSchema }).strict();
export type SessionSystemRecordStoredUpsertResponse = z.infer<typeof SessionSystemRecordStoredUpsertResponseSchema>;
export const SessionSystemRecordStoredReadResponseSchema = z.object({ record: SessionSystemRecordStoredSchema.nullable() }).strict();
export type SessionSystemRecordStoredReadResponse = z.infer<typeof SessionSystemRecordStoredReadResponseSchema>;
export const SessionSystemRecordStoredPageResponseSchema = z.object({
  records: z.array(SessionSystemRecordStoredSchema),
  nextCursor: z.string().trim().min(1).nullable(),
  hasNext: z.boolean(),
}).strict();
export type SessionSystemRecordStoredPageResponse = z.infer<typeof SessionSystemRecordStoredPageResponseSchema>;

/**
 * Narrow host-to-server transport for remote Permission mediation state.
 *
 * This intentionally does not expose a namespace or owner selected by the
 * caller.  The server owns the fixed `permission` host address and the only
 * accepted kinds are the two permission mediation record shapes.
 */
export const SessionPermissionMediationRecordKindSchema = z.enum(
  SESSION_PERMISSION_SYSTEM_RECORD_KINDS,
);
export type SessionPermissionMediationRecordKind = z.infer<
  typeof SessionPermissionMediationRecordKindSchema
>;

export const SessionPermissionMediationRecordStoredSchema = SessionPermissionMediationRecordIdentityV1Schema.extend({
  kind: SessionPermissionMediationRecordKindSchema,
  content: SessionSystemRecordContentSchema,
  revision: SessionSystemRecordRevisionSchema,
}).strict();
export type SessionPermissionMediationRecordStored = z.infer<
  typeof SessionPermissionMediationRecordStoredSchema
>;

export const SessionPermissionMediationRecordReadResponseSchema = z.object({
  record: SessionPermissionMediationRecordStoredSchema.nullable(),
}).strict();
export type SessionPermissionMediationRecordReadResponse = z.infer<
  typeof SessionPermissionMediationRecordReadResponseSchema
>;

export const SessionPermissionMediationRecordWriteRequestSchema = z.object({
  kind: SessionPermissionMediationRecordKindSchema,
  content: SessionSystemRecordContentSchema,
  /** `null` atomically creates only when absent; a revision performs CAS. */
  expectedRevision: SessionSystemRecordRevisionSchema.nullable(),
}).strict();
export type SessionPermissionMediationRecordWriteRequest = z.infer<
  typeof SessionPermissionMediationRecordWriteRequestSchema
>;

export const SessionPermissionMediationRecordWriteResponseSchema = z.object({
  record: SessionPermissionMediationRecordStoredSchema,
}).strict();
export type SessionPermissionMediationRecordWriteResponse = z.infer<
  typeof SessionPermissionMediationRecordWriteResponseSchema
>;

/**
 * Internal retention operation for the fixed Permission mediation ledger.
 * The permission owner first opens and classifies the encrypted row, then
 * supplies its exact revision so this is never a generic record delete.
 */
export const SessionPermissionMediationRecordPruneRequestSchema = z.object({
  expectedRevision: SessionSystemRecordRevisionSchema,
}).strict();
export type SessionPermissionMediationRecordPruneRequest = z.infer<
  typeof SessionPermissionMediationRecordPruneRequestSchema
>;

export const SessionPermissionMediationRecordPruneResponseSchema = z.object({
  ok: z.literal(true),
}).strict();
export type SessionPermissionMediationRecordPruneResponse = z.infer<
  typeof SessionPermissionMediationRecordPruneResponseSchema
>;

export const SessionPermissionMediationRecordListQuerySchema = z.object({
  limit: SessionSystemRecordLimitSchema,
  cursor: SessionSystemRecordCursorSchema,
}).strict();
export type SessionPermissionMediationRecordListQuery = z.infer<
  typeof SessionPermissionMediationRecordListQuerySchema
>;

export const SessionPermissionMediationRecordListResponseSchema = z.object({
  records: z.array(SessionPermissionMediationRecordStoredSchema),
  nextCursor: z.string().trim().min(1).nullable(),
  hasNext: z.boolean(),
}).strict();
export type SessionPermissionMediationRecordListResponse = z.infer<
  typeof SessionPermissionMediationRecordListResponseSchema
>;

export const SESSION_SYSTEM_RECORDS_PLUGIN_ID_HEADER = 'x-happier-plugin-id' as const;

// Released/predecessor host-record transport. This remains seam-local during expansion and
// is intentionally not the author-facing record contract.
export const LegacyHostSessionSystemRecordUpsertRequestSchema = z.object({
  namespace: SessionSystemRecordNamespaceSchema,
  kind: SessionSystemRecordKindSchema,
  localId: LegacyHostSessionSystemRecordLocalIdSchema,
  content: SessionSystemRecordContentSchema,
}).passthrough().superRefine(addSessionSystemRecordPlainContentPayloadIssue);
export type LegacyHostSessionSystemRecordUpsertRequest = z.infer<typeof LegacyHostSessionSystemRecordUpsertRequestSchema>;

export const LegacyHostSessionSystemRecordListQuerySchema = z.object({
  namespace: SessionSystemRecordNamespaceSchema.optional(),
  kind: SessionSystemRecordKindSchema.optional(),
  localId: LegacyHostSessionSystemRecordLocalIdSchema.optional(),
  limit: SessionSystemRecordLimitSchema,
  cursor: SessionSystemRecordCursorSchema,
}).passthrough().superRefine((value, ctx) => {
  if (value.namespace && value.kind) addRegisteredSessionSystemRecordKindIssue({ namespace: value.namespace, kind: value.kind }, ctx);
});
export type LegacyHostSessionSystemRecordListQuery = z.infer<typeof LegacyHostSessionSystemRecordListQuerySchema>;

export const LegacyHostSessionSystemRecordLookupQuerySchema = z.object({
  namespace: SessionSystemRecordNamespaceSchema,
  localId: LegacyHostSessionSystemRecordLocalIdSchema,
}).passthrough();
export type LegacyHostSessionSystemRecordLookupQuery = z.infer<typeof LegacyHostSessionSystemRecordLookupQuerySchema>;

export const LegacyHostSessionSystemRecordLatestQuerySchema = z.object({
  namespace: SessionSystemRecordNamespaceSchema,
  kind: SessionSystemRecordKindSchema,
}).passthrough().superRefine(addRegisteredSessionSystemRecordKindIssue);
export type LegacyHostSessionSystemRecordLatestQuery = z.infer<typeof LegacyHostSessionSystemRecordLatestQuerySchema>;

// Legacy response schemas deliberately remain permissive for old readers while expanded rows
// carry owner/key/version fields internally.
export const LegacyHostSessionSystemRecordSchema = z.object({
  id: z.string().trim().min(1),
  accountId: z.string().trim().min(1).optional(),
  sessionId: z.string().trim().min(1),
  namespace: SessionSystemRecordNamespaceSchema,
  kind: SessionSystemRecordKindSchema,
  localId: LegacyHostSessionSystemRecordLocalIdSchema,
  content: SessionSystemRecordContentSchema,
  createdAt: z.string().trim().min(1),
  updatedAt: z.string().trim().min(1),
}).passthrough().superRefine(addSessionSystemRecordPlainContentPayloadIssue);
export type LegacyHostSessionSystemRecord = z.infer<typeof LegacyHostSessionSystemRecordSchema>;
export const LegacyHostSessionSystemRecordUpsertResponseSchema = z.object({ record: LegacyHostSessionSystemRecordSchema }).passthrough();
export type LegacyHostSessionSystemRecordUpsertResponse = z.infer<typeof LegacyHostSessionSystemRecordUpsertResponseSchema>;
export const LegacyHostSessionSystemRecordPageResponseSchema = z.object({
  records: z.array(LegacyHostSessionSystemRecordSchema), nextCursor: z.string().trim().min(1).nullable(), hasNext: z.boolean(),
}).passthrough();
export type LegacyHostSessionSystemRecordPageResponse = z.infer<typeof LegacyHostSessionSystemRecordPageResponseSchema>;
export const LegacyHostSessionSystemRecordLookupResponseSchema = z.object({ record: LegacyHostSessionSystemRecordSchema.nullable() }).passthrough();
export type LegacyHostSessionSystemRecordLookupResponse = z.infer<typeof LegacyHostSessionSystemRecordLookupResponseSchema>;
export const LegacyHostSessionSystemRecordLatestResponseSchema = z.object({ record: LegacyHostSessionSystemRecordSchema.nullable() }).passthrough();
export type LegacyHostSessionSystemRecordLatestResponse = z.infer<typeof LegacyHostSessionSystemRecordLatestResponseSchema>;
