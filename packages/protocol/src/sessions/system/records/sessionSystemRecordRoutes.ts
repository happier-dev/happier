import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod';

import { StrictJsonValueSchema } from '../../../json/strictJsonValue.js';
import {
  addRegisteredSessionSystemRecordKindIssue,
  addSessionSystemRecordPlainContentPayloadIssue,
} from './sessionSystemRecordCatalog.js';
import { SessionSystemRecordAddressSchema, SessionSystemRecordLocalIdSchema } from './sessionSystemRecordAddress.js';
import { SessionSystemRecordContentSchema } from './sessionSystemRecordContent.js';
import { SessionStoredMessageContentSchema } from '../../messages/sessionStoredMessageContent.js';
import { SessionSystemRecordKindSchema } from './sessionSystemRecordKind.js';
import { SessionSystemRecordNamespaceSchema } from './sessionSystemRecordNamespace.js';
import { SessionSystemRecordSchema } from './sessionSystemRecord.js';
import { SessionSystemRecordRevisionSchema } from './sessionSystemRecordRevision.js';
import {
  SessionPermissionMediationRecordIdentityV1Schema,
  SESSION_PERMISSION_SYSTEM_RECORD_KINDS,
} from '../../permissions/mediationRecordsV1.js';

const SessionSystemRecordCursorSchema = lazyZodSchema(() => z.string().trim().min(1).nullable().optional());
/** The canonical record page ceiling; typed readers over these routes bound their own requests by it. */
export const SESSION_SYSTEM_RECORD_LIST_LIMIT_MAX = 500;
const SessionSystemRecordLimitSchema = lazyZodSchema(() => z.coerce
  .number()
  .int()
  .min(1)
  .max(SESSION_SYSTEM_RECORD_LIST_LIMIT_MAX)
  .default(100));

// Released/predecessor host records accepted trimmed, otherwise-unbounded local ids.
// Keep this seam distinct from the strict author-v1 address schema.
export const LegacyHostSessionSystemRecordLocalIdSchema = lazyZodSchema(() => z.string().trim().min(1));

export const SessionSystemRecordUpsertRequestSchema = lazyZodSchema(() => z.object({
  address: SessionSystemRecordAddressSchema,
  content: StrictJsonValueSchema,
  expectedRevision: SessionSystemRecordRevisionSchema.nullable().optional(),
}).strict());
export type SessionSystemRecordUpsertRequest = z.infer<typeof SessionSystemRecordUpsertRequestSchema>;

export const SessionSystemRecordReadRequestSchema = lazyZodSchema(() => z.object({
  address: SessionSystemRecordAddressSchema,
}).strict());
export type SessionSystemRecordReadRequest = z.infer<typeof SessionSystemRecordReadRequestSchema>;

export const SessionSystemRecordDeleteRequestSchema = lazyZodSchema(() => z.object({
  address: SessionSystemRecordAddressSchema,
  expectedRevision: SessionSystemRecordRevisionSchema.optional(),
}).strict());
export type SessionSystemRecordDeleteRequest = z.infer<typeof SessionSystemRecordDeleteRequestSchema>;

export const SessionSystemRecordDeleteResponseSchema = lazyZodSchema(() => z.object({ ok: z.literal(true) }).strict());
export type SessionSystemRecordDeleteResponse = z.infer<typeof SessionSystemRecordDeleteResponseSchema>;

export const SessionSystemRecordListQuerySchema = lazyZodSchema(() => z.discriminatedUnion('owner', [
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
]));
export type SessionSystemRecordListQuery = z.infer<typeof SessionSystemRecordListQuerySchema>;

export const SessionSystemRecordPageSchema = lazyZodSchema(() => z.object({
  records: z.array(SessionSystemRecordSchema),
  nextCursor: z.string().trim().min(1).nullable(),
  hasNext: z.boolean(),
}).strict());
export type SessionSystemRecordPage = z.infer<typeof SessionSystemRecordPageSchema>;

export const SessionSystemRecordUpsertResponseSchema = lazyZodSchema(() => z.object({ record: SessionSystemRecordSchema }).strict());
export type SessionSystemRecordUpsertResponse = z.infer<typeof SessionSystemRecordUpsertResponseSchema>;
export const SessionSystemRecordReadResponseSchema = lazyZodSchema(() => z.object({ record: SessionSystemRecordSchema.nullable() }).strict());
export type SessionSystemRecordReadResponse = z.infer<typeof SessionSystemRecordReadResponseSchema>;
export const SessionSystemRecordPageResponseSchema = SessionSystemRecordPageSchema;
export type SessionSystemRecordPageResponse = SessionSystemRecordPage;

// Host-internal transport DTOs. Public SessionHandle calls carry opened JSON;
// the CLI seals once and sends this stored envelope to the canonical server owner.
export const SessionSystemRecordStoredSchema = lazyZodSchema(() => SessionSystemRecordSchema.extend({
  content: SessionSystemRecordContentSchema,
}).strict());
export type SessionSystemRecordStored = z.infer<typeof SessionSystemRecordStoredSchema>;
export const SessionSystemRecordStoredUpsertRequestSchema = lazyZodSchema(() => z.object({
  address: SessionSystemRecordAddressSchema,
  content: SessionSystemRecordContentSchema,
  expectedRevision: SessionSystemRecordRevisionSchema.nullable().optional(),
}).strict());
export type SessionSystemRecordStoredUpsertRequest = z.infer<typeof SessionSystemRecordStoredUpsertRequestSchema>;
export const SessionSystemRecordStoredUpsertResponseSchema = lazyZodSchema(() => z.object({ record: SessionSystemRecordStoredSchema }).strict());
export type SessionSystemRecordStoredUpsertResponse = z.infer<typeof SessionSystemRecordStoredUpsertResponseSchema>;
export const SessionSystemRecordStoredReadResponseSchema = lazyZodSchema(() => z.object({ record: SessionSystemRecordStoredSchema.nullable() }).strict());
export type SessionSystemRecordStoredReadResponse = z.infer<typeof SessionSystemRecordStoredReadResponseSchema>;
export const SessionSystemRecordStoredPageResponseSchema = lazyZodSchema(() => z.object({
  records: z.array(SessionSystemRecordStoredSchema),
  nextCursor: z.string().trim().min(1).nullable(),
  hasNext: z.boolean(),
}).strict());
export type SessionSystemRecordStoredPageResponse = z.infer<typeof SessionSystemRecordStoredPageResponseSchema>;

/**
 * Narrow host-to-server transport for remote Permission mediation state.
 *
 * This intentionally does not expose a namespace or owner selected by the
 * caller.  The server owns the fixed `permission` host address and the only
 * accepted kinds are the two permission mediation record shapes.
 */
export const SessionPermissionMediationRecordKindSchema = lazyZodSchema(() => z.enum(
  SESSION_PERMISSION_SYSTEM_RECORD_KINDS,
));
export type SessionPermissionMediationRecordKind = z.infer<
  typeof SessionPermissionMediationRecordKindSchema
>;

export const SessionPermissionMediationRecordStoredSchema = lazyZodSchema(() => SessionPermissionMediationRecordIdentityV1Schema.extend({
  kind: SessionPermissionMediationRecordKindSchema,
  content: SessionSystemRecordContentSchema,
  revision: SessionSystemRecordRevisionSchema,
}).strict());
export type SessionPermissionMediationRecordStored = z.infer<
  typeof SessionPermissionMediationRecordStoredSchema
>;

export const SessionPermissionMediationRecordReadResponseSchema = lazyZodSchema(() => z.object({
  record: SessionPermissionMediationRecordStoredSchema.nullable(),
}).strict());
export type SessionPermissionMediationRecordReadResponse = z.infer<
  typeof SessionPermissionMediationRecordReadResponseSchema
>;

export const SessionPermissionMediationRecordWriteRequestSchema = lazyZodSchema(() => z.object({
  kind: SessionPermissionMediationRecordKindSchema,
  content: SessionSystemRecordContentSchema,
  /** `null` atomically creates only when absent; a revision performs CAS. */
  expectedRevision: SessionSystemRecordRevisionSchema.nullable(),
}).strict());
export type SessionPermissionMediationRecordWriteRequest = z.infer<
  typeof SessionPermissionMediationRecordWriteRequestSchema
>;

export const SessionPermissionMediationRecordWriteResponseSchema = lazyZodSchema(() => z.object({
  record: SessionPermissionMediationRecordStoredSchema,
}).strict());
export type SessionPermissionMediationRecordWriteResponse = z.infer<
  typeof SessionPermissionMediationRecordWriteResponseSchema
>;

/**
 * Internal retention operation for the fixed Permission mediation ledger.
 * The permission owner first opens and classifies the encrypted row, then
 * supplies its exact revision so this is never a generic record delete.
 */
export const SessionPermissionMediationRecordPruneRequestSchema = lazyZodSchema(() => z.object({
  expectedRevision: SessionSystemRecordRevisionSchema,
}).strict());
export type SessionPermissionMediationRecordPruneRequest = z.infer<
  typeof SessionPermissionMediationRecordPruneRequestSchema
>;

export const SessionPermissionMediationRecordPruneResponseSchema = lazyZodSchema(() => z.object({
  ok: z.literal(true),
}).strict());
export type SessionPermissionMediationRecordPruneResponse = z.infer<
  typeof SessionPermissionMediationRecordPruneResponseSchema
>;

export const SessionPermissionMediationRecordListQuerySchema = lazyZodSchema(() => z.object({
  limit: SessionSystemRecordLimitSchema,
  cursor: SessionSystemRecordCursorSchema,
}).strict());
export type SessionPermissionMediationRecordListQuery = z.infer<
  typeof SessionPermissionMediationRecordListQuerySchema
>;

export const SessionPermissionMediationRecordListResponseSchema = lazyZodSchema(() => z.object({
  records: z.array(SessionPermissionMediationRecordStoredSchema),
  nextCursor: z.string().trim().min(1).nullable(),
  hasNext: z.boolean(),
}).strict());
export type SessionPermissionMediationRecordListResponse = z.infer<
  typeof SessionPermissionMediationRecordListResponseSchema
>;

export const SessionSystemRecordErrorResponseSchema = lazyZodSchema(() => z.object({
  error: z.string(),
  code: z.string(),
  currentRevision: z.string().optional(),
}).strict());

/**
 * The System Records producer answers every refusal in this typed body. Readers consume it
 * before any HTTP-status inference, so one operation-scoped denial cannot mean "forbidden"
 * on one host and "you are not signed in" on another.
 */
export function readSessionSystemRecordErrorCodeV1(body: unknown): string | null {
  const parsed = SessionSystemRecordErrorResponseSchema.safeParse(body);
  if (!parsed.success) return null;
  const code = parsed.data.code.trim();
  return code.length > 0 ? code : null;
}

export const SESSION_SYSTEM_RECORDS_PLUGIN_ID_HEADER = 'x-happier-plugin-id' as const;

/**
 * The strict record protocol opt-in a client sends on every v1 System Records request.
 * One wire fact shared by the route guard, every typed client transport and the server's
 * CORS allowlist, so a cross-origin browser preflight can never diverge from what clients send.
 */
export const SESSION_SYSTEM_RECORDS_PROTOCOL_HTTP_HEADER = 'x-happier-session-system-records-protocol' as const;
/** The wire value of {@link SESSION_SYSTEM_RECORDS_PROTOCOL_HTTP_HEADER} for protocol v1. */
export const SESSION_SYSTEM_RECORDS_PROTOCOL_V1_HTTP_HEADER_VALUE = '1' as const;

const LegacyHostNamespaceSchema = lazyZodSchema(() => SessionSystemRecordNamespaceSchema.exclude(['surface']));

// Released/predecessor host-record transport. This remains seam-local during expansion and
// is intentionally not the author-facing record contract.
export const LegacyHostSessionSystemRecordUpsertRequestSchema = lazyZodSchema(() => z.object({
  namespace: LegacyHostNamespaceSchema,
  kind: SessionSystemRecordKindSchema,
  localId: LegacyHostSessionSystemRecordLocalIdSchema,
  content: SessionStoredMessageContentSchema,
}).passthrough().superRefine(addSessionSystemRecordPlainContentPayloadIssue));
export type LegacyHostSessionSystemRecordUpsertRequest = z.infer<typeof LegacyHostSessionSystemRecordUpsertRequestSchema>;

export const LegacyHostSessionSystemRecordListQuerySchema = lazyZodSchema(() => z.object({
  namespace: LegacyHostNamespaceSchema.optional(),
  kind: SessionSystemRecordKindSchema.optional(),
  localId: LegacyHostSessionSystemRecordLocalIdSchema.optional(),
  limit: SessionSystemRecordLimitSchema,
  cursor: SessionSystemRecordCursorSchema,
}).passthrough().superRefine((value, ctx) => {
  if (value.namespace && value.kind) addRegisteredSessionSystemRecordKindIssue({ namespace: value.namespace, kind: value.kind }, ctx);
}));
export type LegacyHostSessionSystemRecordListQuery = z.infer<typeof LegacyHostSessionSystemRecordListQuerySchema>;

export const LegacyHostSessionSystemRecordLookupQuerySchema = lazyZodSchema(() => z.object({
  namespace: LegacyHostNamespaceSchema,
  localId: LegacyHostSessionSystemRecordLocalIdSchema,
}).passthrough());
export type LegacyHostSessionSystemRecordLookupQuery = z.infer<typeof LegacyHostSessionSystemRecordLookupQuerySchema>;

export const LegacyHostSessionSystemRecordLatestQuerySchema = lazyZodSchema(() => z.object({
  namespace: LegacyHostNamespaceSchema,
  kind: SessionSystemRecordKindSchema,
}).passthrough().superRefine(addRegisteredSessionSystemRecordKindIssue));
export type LegacyHostSessionSystemRecordLatestQuery = z.infer<typeof LegacyHostSessionSystemRecordLatestQuerySchema>;

// Legacy response schemas deliberately remain permissive for old readers while expanded rows
// carry owner/key/version fields internally.
export const LegacyHostSessionSystemRecordSchema = lazyZodSchema(() => z.object({
  id: z.string().trim().min(1),
  accountId: z.string().trim().min(1).optional(),
  sessionId: z.string().trim().min(1),
  namespace: LegacyHostNamespaceSchema,
  kind: SessionSystemRecordKindSchema,
  localId: LegacyHostSessionSystemRecordLocalIdSchema,
  content: SessionStoredMessageContentSchema,
  createdAt: z.string().trim().min(1),
  updatedAt: z.string().trim().min(1),
}).passthrough().superRefine(addSessionSystemRecordPlainContentPayloadIssue));
export type LegacyHostSessionSystemRecord = z.infer<typeof LegacyHostSessionSystemRecordSchema>;
export const LegacyHostSessionSystemRecordUpsertResponseSchema = lazyZodSchema(() => z.object({ record: LegacyHostSessionSystemRecordSchema }).passthrough());
export type LegacyHostSessionSystemRecordUpsertResponse = z.infer<typeof LegacyHostSessionSystemRecordUpsertResponseSchema>;
export const LegacyHostSessionSystemRecordPageResponseSchema = lazyZodSchema(() => z.object({
  records: z.array(LegacyHostSessionSystemRecordSchema), nextCursor: z.string().trim().min(1).nullable(), hasNext: z.boolean(),
}).passthrough());
export type LegacyHostSessionSystemRecordPageResponse = z.infer<typeof LegacyHostSessionSystemRecordPageResponseSchema>;
export const LegacyHostSessionSystemRecordLookupResponseSchema = lazyZodSchema(() => z.object({ record: LegacyHostSessionSystemRecordSchema.nullable() }).passthrough());
export type LegacyHostSessionSystemRecordLookupResponse = z.infer<typeof LegacyHostSessionSystemRecordLookupResponseSchema>;
export const LegacyHostSessionSystemRecordLatestResponseSchema = lazyZodSchema(() => z.object({ record: LegacyHostSessionSystemRecordSchema.nullable() }).passthrough());
export type LegacyHostSessionSystemRecordLatestResponse = z.infer<typeof LegacyHostSessionSystemRecordLatestResponseSchema>;
