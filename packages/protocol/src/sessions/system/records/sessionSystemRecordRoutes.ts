import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

import { StrictJsonValueSchema } from '../../../json/strictJsonValue.js';
import { createStoredReadSchema } from '../../../json/storedReadSchema.js';
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

const SessionSystemRecordCursorSchema = lazyZodSchema(() => z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))));
/** The canonical record page ceiling; typed readers over these routes bound their own requests by it. */
export const SESSION_SYSTEM_RECORD_LIST_LIMIT_MAX = 500;
const SessionSystemRecordLimitSchema = lazyZodSchema(() => z._default(z.coerce
  .number().check(z.int(), z.minimum(1), z.maximum(SESSION_SYSTEM_RECORD_LIST_LIMIT_MAX)), 100));

// Released/predecessor host records accepted trimmed, otherwise-unbounded local ids.
// Keep this seam distinct from the strict author-v1 address schema.
export const LegacyHostSessionSystemRecordLocalIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));

export const SessionSystemRecordUpsertRequestSchema = lazyZodSchema(() => z.strictObject({
  address: SessionSystemRecordAddressSchema,
  content: StrictJsonValueSchema,
  expectedRevision: z.optional(z.nullable(SessionSystemRecordRevisionSchema)),
}));
export type SessionSystemRecordUpsertRequest = z.infer<typeof SessionSystemRecordUpsertRequestSchema>;

export const SessionSystemRecordReadRequestSchema = lazyZodSchema(() => z.strictObject({
  address: SessionSystemRecordAddressSchema,
}));
export type SessionSystemRecordReadRequest = z.infer<typeof SessionSystemRecordReadRequestSchema>;

export const SessionSystemRecordDeleteRequestSchema = lazyZodSchema(() => z.strictObject({
  address: SessionSystemRecordAddressSchema,
  expectedRevision: z.optional(SessionSystemRecordRevisionSchema),
}));
export type SessionSystemRecordDeleteRequest = z.infer<typeof SessionSystemRecordDeleteRequestSchema>;

export const SessionSystemRecordDeleteResponseSchema = lazyZodSchema(() => z.strictObject({ ok: z.literal(true) }));
export type SessionSystemRecordDeleteResponse = z.infer<typeof SessionSystemRecordDeleteResponseSchema>;

export const SessionSystemRecordListQuerySchema = lazyZodSchema(() => z.discriminatedUnion('owner', [
  z.strictObject({
    owner: z.literal('plugin'),
    namespace: SessionSystemRecordAddressSchema._zod.def.options[0].shape.namespace,
    kind: z.optional(SessionSystemRecordAddressSchema._zod.def.options[0].shape.kind),
    localId: z.optional(SessionSystemRecordLocalIdSchema),
    limit: SessionSystemRecordLimitSchema,
    cursor: SessionSystemRecordCursorSchema,
  }),
  z.strictObject({
    owner: z.literal('host'),
    namespace: SessionSystemRecordNamespaceSchema,
    kind: z.optional(SessionSystemRecordKindSchema),
    localId: z.optional(SessionSystemRecordLocalIdSchema),
    limit: SessionSystemRecordLimitSchema,
    cursor: SessionSystemRecordCursorSchema,
  }),
]));
export type SessionSystemRecordListQuery = z.infer<typeof SessionSystemRecordListQuerySchema>;

/** A scalar Board inventory projection; never a generic plugin or body read. */
export const SessionSystemRecordCountQuerySchema = lazyZodSchema(() => z.strictObject({
  owner: z.literal('host'),
  namespace: z.literal('surface'),
  kind: z.literal('item.v1'),
  projection: z.literal('count'),
}));
export const SessionSystemRecordCountResponseSchema = lazyZodSchema(() => z.strictObject({
  count: z.number().check(z.int(), z.minimum(0), z.maximum(Number.MAX_SAFE_INTEGER)),
}));
export type SessionSystemRecordCountResponse = z.infer<typeof SessionSystemRecordCountResponseSchema>;

export const SessionSystemRecordPageSchema = lazyZodSchema(() => z.strictObject({
  records: z.array(SessionSystemRecordSchema),
  nextCursor: z.nullable(z.string().check(z.trim(), z.minLength(1))),
  hasNext: z.boolean(),
}));
export type SessionSystemRecordPage = z.infer<typeof SessionSystemRecordPageSchema>;

export const SessionSystemRecordUpsertResponseSchema = lazyZodSchema(() => z.strictObject({ record: SessionSystemRecordSchema }));
export type SessionSystemRecordUpsertResponse = z.infer<typeof SessionSystemRecordUpsertResponseSchema>;
export const SessionSystemRecordReadResponseSchema = lazyZodSchema(() => z.strictObject({ record: z.nullable(SessionSystemRecordSchema) }));
export type SessionSystemRecordReadResponse = z.infer<typeof SessionSystemRecordReadResponseSchema>;
export const SessionSystemRecordPageResponseSchema = SessionSystemRecordPageSchema;
export type SessionSystemRecordPageResponse = SessionSystemRecordPage;

// Host-internal transport DTOs. Public SessionHandle calls carry opened JSON;
// the CLI seals once and sends this stored envelope to the canonical server owner.
export const SessionSystemRecordStoredSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionSystemRecordSchema, {
  content: createStoredReadSchema(SessionSystemRecordContentSchema),
})));
export type SessionSystemRecordStored = z.infer<typeof SessionSystemRecordStoredSchema>;
export const SessionSystemRecordStoredUpsertRequestSchema = lazyZodSchema(() => z.strictObject({
  address: SessionSystemRecordAddressSchema,
  content: SessionSystemRecordContentSchema,
  expectedRevision: z.optional(z.nullable(SessionSystemRecordRevisionSchema)),
}));
export type SessionSystemRecordStoredUpsertRequest = z.infer<typeof SessionSystemRecordStoredUpsertRequestSchema>;
export const SessionSystemRecordStoredUpsertResponseSchema = lazyZodSchema(() => z.strictObject({ record: SessionSystemRecordStoredSchema }));
export type SessionSystemRecordStoredUpsertResponse = z.infer<typeof SessionSystemRecordStoredUpsertResponseSchema>;
export const SessionSystemRecordStoredReadResponseSchema = lazyZodSchema(() => z.strictObject({ record: z.nullable(SessionSystemRecordStoredSchema) }));
export type SessionSystemRecordStoredReadResponse = z.infer<typeof SessionSystemRecordStoredReadResponseSchema>;
export const SessionSystemRecordStoredPageResponseSchema = lazyZodSchema(() => z.strictObject({
  records: z.array(SessionSystemRecordStoredSchema),
  nextCursor: z.nullable(z.string().check(z.trim(), z.minLength(1))),
  hasNext: z.boolean(),
}));
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

export const SessionPermissionMediationRecordStoredSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionPermissionMediationRecordIdentityV1Schema, {
  kind: SessionPermissionMediationRecordKindSchema,
  content: createStoredReadSchema(SessionSystemRecordContentSchema),
  revision: SessionSystemRecordRevisionSchema,
})));
export type SessionPermissionMediationRecordStored = z.infer<
  typeof SessionPermissionMediationRecordStoredSchema
>;

export const SessionPermissionMediationRecordReadResponseSchema = lazyZodSchema(() => z.strictObject({
  record: z.nullable(SessionPermissionMediationRecordStoredSchema),
}));
export type SessionPermissionMediationRecordReadResponse = z.infer<
  typeof SessionPermissionMediationRecordReadResponseSchema
>;

export const SessionPermissionMediationRecordWriteRequestSchema = lazyZodSchema(() => z.strictObject({
  kind: SessionPermissionMediationRecordKindSchema,
  content: SessionSystemRecordContentSchema,
  /** `null` atomically creates only when absent; a revision performs CAS. */
  expectedRevision: z.nullable(SessionSystemRecordRevisionSchema),
}));
export type SessionPermissionMediationRecordWriteRequest = z.infer<
  typeof SessionPermissionMediationRecordWriteRequestSchema
>;

export const SessionPermissionMediationRecordWriteResponseSchema = lazyZodSchema(() => z.strictObject({
  record: SessionPermissionMediationRecordStoredSchema,
}));
export type SessionPermissionMediationRecordWriteResponse = z.infer<
  typeof SessionPermissionMediationRecordWriteResponseSchema
>;

/**
 * Internal retention operation for the fixed Permission mediation ledger.
 * The permission owner first opens and classifies the encrypted row, then
 * supplies its exact revision so this is never a generic record delete.
 */
export const SessionPermissionMediationRecordPruneRequestSchema = lazyZodSchema(() => z.strictObject({
  expectedRevision: SessionSystemRecordRevisionSchema,
}));
export type SessionPermissionMediationRecordPruneRequest = z.infer<
  typeof SessionPermissionMediationRecordPruneRequestSchema
>;

export const SessionPermissionMediationRecordPruneResponseSchema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true),
}));
export type SessionPermissionMediationRecordPruneResponse = z.infer<
  typeof SessionPermissionMediationRecordPruneResponseSchema
>;

export const SessionPermissionMediationRecordListQuerySchema = lazyZodSchema(() => z.strictObject({
  limit: SessionSystemRecordLimitSchema,
  cursor: SessionSystemRecordCursorSchema,
}));
export type SessionPermissionMediationRecordListQuery = z.infer<
  typeof SessionPermissionMediationRecordListQuerySchema
>;

export const SessionPermissionMediationRecordListResponseSchema = lazyZodSchema(() => z.strictObject({
  records: z.array(SessionPermissionMediationRecordStoredSchema),
  nextCursor: z.nullable(z.string().check(z.trim(), z.minLength(1))),
  hasNext: z.boolean(),
}));
export type SessionPermissionMediationRecordListResponse = z.infer<
  typeof SessionPermissionMediationRecordListResponseSchema
>;

export const SessionSystemRecordErrorResponseSchema = lazyZodSchema(() => z.strictObject({
  error: z.string(),
  code: z.string(),
  currentRevision: z.optional(z.string()),
}));

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

const LegacyHostNamespaceSchema = lazyZodSchema(() => z.enum(SessionSystemRecordNamespaceSchema.options.filter((value): value is Exclude<(typeof SessionSystemRecordNamespaceSchema.options)[number], 'surface'> => !(['surface'] as readonly string[]).includes(value))));

// Released/predecessor host-record transport. This remains seam-local during expansion and
// is intentionally not the author-facing record contract.
export const LegacyHostSessionSystemRecordUpsertRequestSchema = lazyZodSchema(() => z.looseObject({
  namespace: LegacyHostNamespaceSchema,
  kind: SessionSystemRecordKindSchema,
  localId: LegacyHostSessionSystemRecordLocalIdSchema,
  content: SessionStoredMessageContentSchema,
}).check(z.superRefine(addSessionSystemRecordPlainContentPayloadIssue)));
export type LegacyHostSessionSystemRecordUpsertRequest = z.infer<typeof LegacyHostSessionSystemRecordUpsertRequestSchema>;

export const LegacyHostSessionSystemRecordListQuerySchema = lazyZodSchema(() => z.looseObject({
  namespace: z.optional(LegacyHostNamespaceSchema),
  kind: z.optional(SessionSystemRecordKindSchema),
  localId: z.optional(LegacyHostSessionSystemRecordLocalIdSchema),
  limit: SessionSystemRecordLimitSchema,
  cursor: SessionSystemRecordCursorSchema,
}).check(z.superRefine((value, ctx) => {
  if (value.namespace && value.kind) addRegisteredSessionSystemRecordKindIssue({ namespace: value.namespace, kind: value.kind }, ctx);
})));
export type LegacyHostSessionSystemRecordListQuery = z.infer<typeof LegacyHostSessionSystemRecordListQuerySchema>;

export const LegacyHostSessionSystemRecordLookupQuerySchema = lazyZodSchema(() => z.looseObject({
  namespace: LegacyHostNamespaceSchema,
  localId: LegacyHostSessionSystemRecordLocalIdSchema,
}));
export type LegacyHostSessionSystemRecordLookupQuery = z.infer<typeof LegacyHostSessionSystemRecordLookupQuerySchema>;

export const LegacyHostSessionSystemRecordLatestQuerySchema = lazyZodSchema(() => z.looseObject({
  namespace: LegacyHostNamespaceSchema,
  kind: SessionSystemRecordKindSchema,
}).check(z.superRefine(addRegisteredSessionSystemRecordKindIssue)));
export type LegacyHostSessionSystemRecordLatestQuery = z.infer<typeof LegacyHostSessionSystemRecordLatestQuerySchema>;

// Legacy response schemas deliberately remain permissive for old readers while expanded rows
// carry owner/key/version fields internally.
export const LegacyHostSessionSystemRecordSchema = lazyZodSchema(() => z.looseObject({
  id: z.string().check(z.trim(), z.minLength(1)),
  accountId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  sessionId: z.string().check(z.trim(), z.minLength(1)),
  namespace: LegacyHostNamespaceSchema,
  kind: SessionSystemRecordKindSchema,
  localId: LegacyHostSessionSystemRecordLocalIdSchema,
  content: SessionStoredMessageContentSchema,
  createdAt: z.string().check(z.trim(), z.minLength(1)),
  updatedAt: z.string().check(z.trim(), z.minLength(1)),
}).check(z.superRefine(addSessionSystemRecordPlainContentPayloadIssue)));
export type LegacyHostSessionSystemRecord = z.infer<typeof LegacyHostSessionSystemRecordSchema>;
export const LegacyHostSessionSystemRecordUpsertResponseSchema = lazyZodSchema(() => z.looseObject({ record: LegacyHostSessionSystemRecordSchema }));
export type LegacyHostSessionSystemRecordUpsertResponse = z.infer<typeof LegacyHostSessionSystemRecordUpsertResponseSchema>;
export const LegacyHostSessionSystemRecordPageResponseSchema = lazyZodSchema(() => z.looseObject({
  records: z.array(LegacyHostSessionSystemRecordSchema), nextCursor: z.nullable(z.string().check(z.trim(), z.minLength(1))), hasNext: z.boolean(),
}));
export type LegacyHostSessionSystemRecordPageResponse = z.infer<typeof LegacyHostSessionSystemRecordPageResponseSchema>;
export const LegacyHostSessionSystemRecordLookupResponseSchema = lazyZodSchema(() => z.looseObject({ record: z.nullable(LegacyHostSessionSystemRecordSchema) }));
export type LegacyHostSessionSystemRecordLookupResponse = z.infer<typeof LegacyHostSessionSystemRecordLookupResponseSchema>;
export const LegacyHostSessionSystemRecordLatestResponseSchema = lazyZodSchema(() => z.looseObject({ record: z.nullable(LegacyHostSessionSystemRecordSchema) }));
export type LegacyHostSessionSystemRecordLatestResponse = z.infer<typeof LegacyHostSessionSystemRecordLatestResponseSchema>;
