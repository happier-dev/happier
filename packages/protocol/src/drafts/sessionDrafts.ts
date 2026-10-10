import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { getAccountScopedBlobCiphertextBase64LengthV1 } from '../crypto/accountScopedCipherEnvelope.js';
import {
  StrictJsonValueSchema,
  type JsonValue as StrictJsonValue,
} from '../json/strictJsonValue.js';
import { ParticipantRecipientV1Schema } from '../messages/structured/participantMessageV1.js';
import { ScmDiffSummaryDiscussInputSchema } from '../scm/diffSummaryResult.js';
import {
  SyncedSessionAuthoringValueV1Schema,
} from '../sessions/authoring/syncedSessionAuthoringV1.js';

export const SESSION_DRAFT_MAX_ID_UTF8_BYTES = 256;
export const SESSION_DRAFT_MAX_FIELDS = 256;
export const SESSION_DRAFT_MAX_PRIVATE_PAYLOAD_BYTES = 512 * 1024;
export const SESSION_DRAFT_MAX_CIPHERTEXT_LENGTH = getAccountScopedBlobCiphertextBase64LengthV1(
  SESSION_DRAFT_MAX_PRIVATE_PAYLOAD_BYTES,
);
export const SESSION_DRAFT_SOCKET_EVENT = 'session-draft-updated' as const;
export const SESSION_DRAFT_ROUTE_READ = '/v1/account/session-drafts/read' as const;
export const SESSION_DRAFT_ROUTE_LIST = '/v1/account/session-drafts/list' as const;
export const SESSION_DRAFT_ROUTE_MUTATE = '/v1/account/session-drafts/mutate' as const;

const utf8Length = (value: string): number => new TextEncoder().encode(value).byteLength;
const BoundedDraftIdSchema = lazyZodSchema(() => z.string().refine(
  (value) => utf8Length(value) <= SESSION_DRAFT_MAX_ID_UTF8_BYTES,
  'Draft identifier exceeds the UTF-8 byte boundary',
));

export const SessionDraftAddressV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('newSession'), draftId: BoundedDraftIdSchema.uuid() }).strict(),
  z.object({ kind: z.literal('session'), sessionId: BoundedDraftIdSchema.min(1) }).strict(),
]));
export type SessionDraftAddressV1 = z.infer<typeof SessionDraftAddressV1Schema>;

export function canonicalSessionDraftAddressV1(address: SessionDraftAddressV1): string {
  return address.kind === 'newSession'
    ? `new-session/${address.draftId}`
    : `session/${encodeURIComponent(address.sessionId)}`;
}

function isCanonicalSessionDraftAddressV1(value: string): boolean {
  if (value.startsWith('new-session/')) {
    const parsed = SessionDraftAddressV1Schema.safeParse({
      kind: 'newSession',
      draftId: value.slice('new-session/'.length),
    });
    return parsed.success && canonicalSessionDraftAddressV1(parsed.data) === value;
  }
  if (!value.startsWith('session/')) return false;
  try {
    const parsed = SessionDraftAddressV1Schema.safeParse({
      kind: 'session',
      sessionId: decodeURIComponent(value.slice('session/'.length)),
    });
    return parsed.success && canonicalSessionDraftAddressV1(parsed.data) === value;
  } catch {
    return false;
  }
}

export const CanonicalSessionDraftAddressV1Schema = lazyZodSchema(() => z.string().min(1).refine(
  isCanonicalSessionDraftAddressV1,
  'Expected a canonical session draft address',
));
export type CanonicalSessionDraftAddressV1 = z.infer<typeof CanonicalSessionDraftAddressV1Schema>;

export { StrictJsonValueSchema };
export type { StrictJsonValue };
export type StrictJsonObject = Extract<
  StrictJsonValue,
  { readonly [key: string]: StrictJsonValue }
>;

export const DraftFieldV1Schema = lazyZodSchema(() => z.object({
  mutationId: z.string().uuid(),
  value: StrictJsonValueSchema,
}).strict());
export type DraftFieldV1<T extends StrictJsonValue = StrictJsonValue> = Readonly<{
  mutationId: string;
  value: T;
}>;

/**
 * Reader-facing name retained for consumers that project the released 0.2
 * flat authoring vocabulary into current selections. The released V1 catalog
 * itself remains the sole schema owner.
 */
export const SessionDraftPredecessorAuthoringValueV1Schema = SyncedSessionAuthoringValueV1Schema;
export type SessionDraftPredecessorAuthoringValueV1 = z.infer<
  typeof SessionDraftPredecessorAuthoringValueV1Schema
>;

export const SessionDraftRecipientValueV1Schema = lazyZodSchema(() => z.union([
  z.null(),
  z.object({
    mode: z.literal('manual'),
    recipient: ParticipantRecipientV1Schema.nullable(),
  }).strict(),
  z.object({
    mode: z.literal('scm_diff_summary'),
    recipient: ParticipantRecipientV1Schema.nullable(),
    target: ScmDiffSummaryDiscussInputSchema.omit({ message: true }),
  }).strict().refine((value) => value.target.startNew === true
    ? value.recipient === null
    : value.recipient?.kind === 'execution_run', 'Discussion must name a Run or explicitly start a new one'),
]));
export type SessionDraftRecipientValueV1 = z.infer<typeof SessionDraftRecipientValueV1Schema>;

export function isMeaningfulSessionDraftRecipientValueV1(
  value: unknown,
): value is Exclude<SessionDraftRecipientValueV1, null> {
  const parsed = SessionDraftRecipientValueV1Schema.safeParse(value);
  return parsed.success && parsed.data !== null;
}

const semanticArraySchema = lazyZodSchema(() => z.preprocess(
  (input) => Array.isArray(input)
    ? input.filter((entry) => StrictJsonValueSchema.safeParse(entry).success)
    : input,
  z.array(StrictJsonValueSchema),
));
const ComposerSchema = lazyZodSchema(() => z.object({
  text: z.object({ mutationId: z.string().uuid(), value: z.string() }).strict(),
  mentions: z.object({ mutationId: z.string().uuid(), value: semanticArraySchema }).strict(),
  attachments: z.object({ mutationId: z.string().uuid(), value: semanticArraySchema }).strict(),
}).strict());

/** Each draft epoch validates field values through its exact catalog projection. */
export function createSessionDraftAuthoringFieldsSchema<TShape extends Record<string, z.ZodType>>(
  valueSchema: z.ZodObject<TShape>,
): z.ZodType<Partial<Record<Extract<keyof TShape, string>, DraftFieldV1>>> {
  type FieldId = Extract<keyof TShape, string>;
  const fieldIds = Object.keys(valueSchema.shape) as [FieldId, ...FieldId[]];
  const currentShape: Readonly<Record<string, z.ZodType>> = valueSchema.shape;
  return z
  .partialRecord(z.enum(fieldIds), DraftFieldV1Schema)
  .superRefine((fields, context) => {
    for (const [fieldId, field] of Object.entries(fields)) {
      const parsedField = DraftFieldV1Schema.safeParse(field);
      if (!parsedField.success) continue;
      const currentFieldSchema = currentShape[fieldId];
      const isValidCurrentValue = currentFieldSchema?.safeParse(parsedField.data.value).success === true;
      if (!isValidCurrentValue) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [fieldId, 'value'],
          message: `Invalid synchronized authoring value for ${fieldId}`,
        });
      }
    }
  });
}
const SyncedAuthoringFieldsSchema = createSessionDraftAuthoringFieldsSchema(
  SyncedSessionAuthoringValueV1Schema,
);
const ExtensionFieldsSchema = lazyZodSchema(() => z.record(
  BoundedDraftIdSchema,
  z.record(BoundedDraftIdSchema, DraftFieldV1Schema),
));

export const SessionDraftDocumentV1Schema = lazyZodSchema(() => z.object({
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
}).strict().superRefine((document, context) => {
  const targetFields = document.target.kind === 'newSession'
    ? Object.keys(document.target.authoring).length
    : 3;
  const extensionFields = Object.values(document.extensions)
    .reduce((count, fields) => count + Object.keys(fields).length, 0);
  if (3 + targetFields + extensionFields > SESSION_DRAFT_MAX_FIELDS) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Draft field count exceeds the supported boundary',
    });
  }
}));
export type SessionDraftDocumentV1 = z.infer<typeof SessionDraftDocumentV1Schema>;

export const SessionDraftPrivatePayloadV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  address: SessionDraftAddressV1Schema,
  document: SessionDraftDocumentV1Schema,
}).strict().superRefine((payload, context) => {
  if (payload.address.kind !== payload.document.target.kind) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['document', 'target', 'kind'],
      message: 'Draft payload address and document target must agree',
    });
  }
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > SESSION_DRAFT_MAX_PRIVATE_PAYLOAD_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Draft private payload exceeds the supported boundary',
    });
  }
}));
export type SessionDraftPrivatePayloadV1 = z.infer<typeof SessionDraftPrivatePayloadV1Schema>;

export const SessionDraftStoredContentEnvelopeV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.object({ t: z.literal('plain'), v: SessionDraftPrivatePayloadV1Schema }).strict(),
  z.object({
    t: z.literal('encrypted'),
    c: z.string().min(1).max(SESSION_DRAFT_MAX_CIPHERTEXT_LENGTH),
  }).strict(),
]));
export type SessionDraftStoredContentEnvelopeV1 = z.infer<typeof SessionDraftStoredContentEnvelopeV1Schema>;

export const SessionDraftRecordV1Schema = lazyZodSchema(() => z.object({
  address: SessionDraftAddressV1Schema,
  revision: z.number().int().nonnegative(),
  content: SessionDraftStoredContentEnvelopeV1Schema.nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict());
export type SessionDraftRecordV1 = z.infer<typeof SessionDraftRecordV1Schema>;

export const SessionDraftReadRequestV1Schema = lazyZodSchema(() => z.object({ address: SessionDraftAddressV1Schema }).strict());
export type SessionDraftReadRequestV1 = z.infer<typeof SessionDraftReadRequestV1Schema>;
export const SessionDraftReadResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({ status: z.literal('present'), record: SessionDraftRecordV1Schema }).strict(),
  z.object({ status: z.literal('deleted'), record: SessionDraftRecordV1Schema }).strict(),
  z.object({ status: z.literal('absent') }).strict(),
]));
export type SessionDraftReadResponseV1 = z.infer<typeof SessionDraftReadResponseV1Schema>;

export const SessionDraftListRequestV1Schema = lazyZodSchema(() => z.object({
  after: CanonicalSessionDraftAddressV1Schema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict());
export type SessionDraftListRequestV1 = z.infer<typeof SessionDraftListRequestV1Schema>;
export const SessionDraftListResponseV1Schema = lazyZodSchema(() => z.object({
  items: z.array(SessionDraftRecordV1Schema),
  nextAfter: CanonicalSessionDraftAddressV1Schema.optional(),
}).strict());
export type SessionDraftListResponseV1 = z.infer<typeof SessionDraftListResponseV1Schema>;

export const SessionDraftExpectedRevisionV1Schema = lazyZodSchema(() => z.union([
  z.number().int().nonnegative(),
  z.literal('absent'),
]));
export type SessionDraftExpectedRevisionV1 = z.infer<typeof SessionDraftExpectedRevisionV1Schema>;
export const SessionDraftMutateRequestV1Schema = lazyZodSchema(() => z.object({
  address: SessionDraftAddressV1Schema,
  expectedRevision: SessionDraftExpectedRevisionV1Schema,
  content: SessionDraftStoredContentEnvelopeV1Schema.nullable(),
}).strict());
export type SessionDraftMutateRequestV1 = z.infer<typeof SessionDraftMutateRequestV1Schema>;
export const SessionDraftMutateResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({ status: z.literal('updated'), record: SessionDraftRecordV1Schema }).strict(),
  z.object({
    status: z.literal('conflict'),
    current: z.union([
      SessionDraftRecordV1Schema,
      z.object({ status: z.literal('absent') }).strict(),
    ]),
  }).strict(),
]));
export type SessionDraftMutateResponseV1 = z.infer<typeof SessionDraftMutateResponseV1Schema>;
export const SessionDraftRouteErrorResponseV1Schema = lazyZodSchema(() => z.object({
  error: z.enum(['session_unavailable', 'invalid_content_mode', 'invalid_address_binding']),
}).strict());
export type SessionDraftRouteErrorResponseV1 = z.infer<
  typeof SessionDraftRouteErrorResponseV1Schema
>;

export const SessionDraftChangeHintV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  sessionDraft: z.literal(true),
  address: SessionDraftAddressV1Schema,
  revision: z.number().int().nonnegative(),
  status: z.enum(['present', 'deleted']),
}).strict());
export type SessionDraftChangeHintV1 = z.infer<typeof SessionDraftChangeHintV1Schema>;
export const SessionDraftSocketUpdateV1Schema = SessionDraftChangeHintV1Schema;
export type SessionDraftSocketUpdateV1 = SessionDraftChangeHintV1;
