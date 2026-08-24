import { z } from 'zod';

import { SyncedSessionAuthoringFieldIdV1Schema, SyncedSessionAuthoringValueV1Schema } from '../sessionAuthoring/index.js';
import { accountScopedCiphertextBase64LengthForPlaintextBytes } from '../crypto/accountScopedCipher.js';
import { ParticipantRecipientV1Schema } from '../structuredMessages/participantMessageV1.js';

export const SESSION_DRAFT_MAX_ID_UTF8_BYTES = 256;
export const SESSION_DRAFT_MAX_FIELDS = 256;
export const SESSION_DRAFT_MAX_PRIVATE_PAYLOAD_BYTES = 512 * 1024;
export const SESSION_DRAFT_MAX_CIPHERTEXT_LENGTH = accountScopedCiphertextBase64LengthForPlaintextBytes(
  SESSION_DRAFT_MAX_PRIVATE_PAYLOAD_BYTES,
);
export const SESSION_DRAFT_SOCKET_EVENT = 'session-draft-updated' as const;
export const SESSION_DRAFT_ROUTE_READ = '/v1/account/session-drafts/read' as const;
export const SESSION_DRAFT_ROUTE_LIST = '/v1/account/session-drafts/list' as const;
export const SESSION_DRAFT_ROUTE_MUTATE = '/v1/account/session-drafts/mutate' as const;

const utf8Length = (value: string): number => new TextEncoder().encode(value).byteLength;
const BoundedDraftIdSchema = z.string().refine(
  (value) => utf8Length(value) <= SESSION_DRAFT_MAX_ID_UTF8_BYTES,
  'Draft identifier exceeds the UTF-8 byte boundary',
);

export const SessionDraftAddressV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('newSession'), draftId: BoundedDraftIdSchema.uuid() }).strict(),
  z.object({ kind: z.literal('session'), sessionId: BoundedDraftIdSchema.min(1) }).strict(),
]);
export type SessionDraftAddressV1 = z.infer<typeof SessionDraftAddressV1Schema>;

export function canonicalSessionDraftAddressV1(address: SessionDraftAddressV1): string {
  return address.kind === 'newSession' ? `new-session/${address.draftId}` : `session/${encodeURIComponent(address.sessionId)}`;
}

function isCanonicalSessionDraftAddressV1(value: string): boolean {
  if (value.startsWith('new-session/')) {
    const address = SessionDraftAddressV1Schema.safeParse({
      kind: 'newSession',
      draftId: value.slice('new-session/'.length),
    });
    return address.success && canonicalSessionDraftAddressV1(address.data) === value;
  }
  if (!value.startsWith('session/')) return false;
  try {
    const address = SessionDraftAddressV1Schema.safeParse({
      kind: 'session',
      sessionId: decodeURIComponent(value.slice('session/'.length)),
    });
    return address.success && canonicalSessionDraftAddressV1(address.data) === value;
  } catch {
    return false;
  }
}

export const CanonicalSessionDraftAddressV1Schema = z.string().min(1).refine(
  isCanonicalSessionDraftAddressV1,
  'Expected a canonical session draft address',
);
export type CanonicalSessionDraftAddressV1 = z.infer<typeof CanonicalSessionDraftAddressV1Schema>;

export interface StrictJsonObject { readonly [key: string]: StrictJsonValue }
export type StrictJsonValue = null | string | number | boolean | readonly StrictJsonValue[] | StrictJsonObject;
export const StrictJsonValueSchema: z.ZodType<StrictJsonValue> = z.lazy(() => z.union([
  z.null(), z.string(), z.number().finite(), z.boolean(), z.array(StrictJsonValueSchema), z.record(z.string(), StrictJsonValueSchema),
]));

export const DraftFieldV1Schema = z.object({ mutationId: z.string().uuid(), value: StrictJsonValueSchema }).strict();
export type DraftFieldV1<T extends StrictJsonValue = StrictJsonValue> = Readonly<{ mutationId: string; value: T }>;

export const SessionDraftRecipientValueV1Schema = z.union([
  z.null(),
  z.object({
    mode: z.literal('manual'),
    recipient: ParticipantRecipientV1Schema.nullable(),
  }).strict(),
]);
export type SessionDraftRecipientValueV1 = z.infer<typeof SessionDraftRecipientValueV1Schema>;

export function isMeaningfulSessionDraftRecipientValueV1(value: unknown): value is Exclude<SessionDraftRecipientValueV1, null> {
  const parsed = SessionDraftRecipientValueV1Schema.safeParse(value);
  return parsed.success && parsed.data !== null;
}

const semanticArraySchema = z.preprocess(
  (input) => Array.isArray(input) ? input.filter((entry) => StrictJsonValueSchema.safeParse(entry).success) : input,
  z.array(StrictJsonValueSchema),
);
const ComposerSchema = z.object({
  text: z.object({ mutationId: z.string().uuid(), value: z.string() }).strict(),
  mentions: z.object({ mutationId: z.string().uuid(), value: semanticArraySchema }).strict(),
  attachments: z.object({ mutationId: z.string().uuid(), value: semanticArraySchema }).strict(),
}).strict();

const SyncedAuthoringFieldsSchema = z.partialRecord(SyncedSessionAuthoringFieldIdV1Schema, DraftFieldV1Schema)
  .superRefine((fields, ctx) => {
    for (const [fieldId, field] of Object.entries(fields as Record<string, { value: unknown }>)) {
      const fieldSchema = (SyncedSessionAuthoringValueV1Schema.shape as Record<string, z.ZodTypeAny>)[fieldId];
      if (!fieldSchema) continue;
      if (!fieldSchema.safeParse(field.value).success) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [fieldId, 'value'], message: `Invalid synchronized authoring value for ${fieldId}` });
      }
    }
  });
const ExtensionFieldsSchema = z.record(BoundedDraftIdSchema, z.record(BoundedDraftIdSchema, DraftFieldV1Schema));

export const SessionDraftDocumentV1Schema = z.object({
  v: z.literal(1),
  composer: ComposerSchema,
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('newSession'), authoring: SyncedAuthoringFieldsSchema }).strict(),
    z.object({
      kind: z.literal('session'),
      routing: z.object({
        recipient: DraftFieldV1Schema,
        agentContinuation: DraftFieldV1Schema,
        executionRunDelivery: DraftFieldV1Schema,
      }).strict(),
    }).strict(),
  ]),
  extensions: ExtensionFieldsSchema,
}).strict().superRefine((document, ctx) => {
  const targetFields = document.target.kind === 'newSession' ? Object.keys(document.target.authoring).length : 3;
  const extensionFields = Object.values(document.extensions).reduce((count, fields) => count + Object.keys(fields).length, 0);
  if (3 + targetFields + extensionFields > SESSION_DRAFT_MAX_FIELDS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Draft field count exceeds the supported boundary' });
  }
});
export type SessionDraftDocumentV1 = z.infer<typeof SessionDraftDocumentV1Schema>;

export const SessionDraftPrivatePayloadV1Schema = z.object({
  v: z.literal(1), address: SessionDraftAddressV1Schema, document: SessionDraftDocumentV1Schema,
}).strict().superRefine((payload, ctx) => {
  if (payload.address.kind !== payload.document.target.kind) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['document', 'target', 'kind'], message: 'Draft payload address and document target must agree' });
  }
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > SESSION_DRAFT_MAX_PRIVATE_PAYLOAD_BYTES) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Draft private payload exceeds the supported boundary' });
  }
});
export type SessionDraftPrivatePayloadV1 = z.infer<typeof SessionDraftPrivatePayloadV1Schema>;

export const SessionDraftStoredContentEnvelopeV1Schema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('plain'), v: SessionDraftPrivatePayloadV1Schema }).strict(),
  z.object({ t: z.literal('encrypted'), c: z.string().min(1).max(SESSION_DRAFT_MAX_CIPHERTEXT_LENGTH) }).strict(),
]);
export type SessionDraftStoredContentEnvelopeV1 = z.infer<typeof SessionDraftStoredContentEnvelopeV1Schema>;

export const SessionDraftRecordV1Schema = z.object({
  address: SessionDraftAddressV1Schema,
  revision: z.number().int().nonnegative(),
  content: SessionDraftStoredContentEnvelopeV1Schema.nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict();
export type SessionDraftRecordV1 = z.infer<typeof SessionDraftRecordV1Schema>;

export const SessionDraftReadRequestV1Schema = z.object({ address: SessionDraftAddressV1Schema }).strict();
export type SessionDraftReadRequestV1 = z.infer<typeof SessionDraftReadRequestV1Schema>;
export const SessionDraftReadResponseV1Schema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('present'), record: SessionDraftRecordV1Schema }).strict(),
  z.object({ status: z.literal('deleted'), record: SessionDraftRecordV1Schema }).strict(),
  z.object({ status: z.literal('absent') }).strict(),
]);
export type SessionDraftReadResponseV1 = z.infer<typeof SessionDraftReadResponseV1Schema>;

export const SessionDraftListRequestV1Schema = z.object({
  after: CanonicalSessionDraftAddressV1Schema.optional(), limit: z.number().int().min(1).max(100).optional(),
}).strict();
export type SessionDraftListRequestV1 = z.infer<typeof SessionDraftListRequestV1Schema>;
export const SessionDraftListResponseV1Schema = z.object({
  items: z.array(SessionDraftRecordV1Schema), nextAfter: CanonicalSessionDraftAddressV1Schema.optional(),
}).strict();
export type SessionDraftListResponseV1 = z.infer<typeof SessionDraftListResponseV1Schema>;

export const SessionDraftExpectedRevisionV1Schema = z.union([z.number().int().nonnegative(), z.literal('absent')]);
export type SessionDraftExpectedRevisionV1 = z.infer<typeof SessionDraftExpectedRevisionV1Schema>;
export const SessionDraftMutateRequestV1Schema = z.object({
  address: SessionDraftAddressV1Schema,
  expectedRevision: SessionDraftExpectedRevisionV1Schema,
  content: SessionDraftStoredContentEnvelopeV1Schema.nullable(),
}).strict();
export type SessionDraftMutateRequestV1 = z.infer<typeof SessionDraftMutateRequestV1Schema>;
export const SessionDraftMutateResponseV1Schema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('updated'), record: SessionDraftRecordV1Schema }).strict(),
  z.object({ status: z.literal('conflict'), current: z.union([
    SessionDraftRecordV1Schema, z.object({ status: z.literal('absent') }).strict(),
  ]) }).strict(),
]);
export type SessionDraftMutateResponseV1 = z.infer<typeof SessionDraftMutateResponseV1Schema>;
export const SessionDraftRouteErrorResponseV1Schema = z.object({
  error: z.enum(['session_unavailable', 'invalid_content_mode', 'invalid_address_binding']),
}).strict();
export type SessionDraftRouteErrorResponseV1 = z.infer<typeof SessionDraftRouteErrorResponseV1Schema>;

export const SessionDraftChangeHintV1Schema = z.object({
  v: z.literal(1), sessionDraft: z.literal(true), address: SessionDraftAddressV1Schema,
  revision: z.number().int().nonnegative(), status: z.enum(['present', 'deleted']),
}).strict();
export type SessionDraftChangeHintV1 = z.infer<typeof SessionDraftChangeHintV1Schema>;
export const SessionDraftSocketUpdateV1Schema = SessionDraftChangeHintV1Schema;
export type SessionDraftSocketUpdateV1 = SessionDraftChangeHintV1;
