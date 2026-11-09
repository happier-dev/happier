import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { ConversationTurnOriginV1Schema } from '../../../messages/structured/conversationTurnOriginV1.js';
import { ExternalShareableTranscriptPageV1Schema } from '../../../sessions/messages/sessionExternalShareableTranscriptV1.js';


export const SessionTranscriptRoleSchema = lazyZodSchema(() => z.enum(['user', 'assistant']));
export const SessionStoredTranscriptRoleSchema = lazyZodSchema(() => z.enum(['user', 'agent', 'event', 'unknown']));

export const SessionTranscriptGetExternalShareableProjectionSchema = lazyZodSchema(() => z.literal('externalShareableV1'));

/**
 * The largest page `session.transcript.get` will return for one request.
 *
 * Named here because the bound has consumers outside the schema: the reader
 * clamps to it, and a caller that wants the fewest possible round trips asks
 * for exactly it. Each of those was carrying its own copy of the number, so
 * lowering the bound left them confidently over-asking.
 */
export const SESSION_TRANSCRIPT_GET_MAX_LIMIT = 100;

export const SessionTranscriptGetInputShape = {
  sessionId: z.string().check(z.minLength(1)),
  messageId: z.optional(z.string().check(z.minLength(1))),
  projection: z.optional(SessionTranscriptGetExternalShareableProjectionSchema),
  limit: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(SESSION_TRANSCRIPT_GET_MAX_LIMIT))),
  cursor: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  direction: z.optional(z.enum(['before', 'after'])),
  scope: z.optional(z.enum(['main', 'sidechain', 'all'])),
  sidechainId: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  roles: z.optional(z.array(SessionTranscriptRoleSchema)),
  includeTools: z.optional(z.boolean()),
  includeReasoning: z.optional(z.boolean()),
  includeEvents: z.optional(z.boolean()),
  includeMeta: z.optional(z.boolean()),
  includeStructuredPayload: z.optional(z.boolean()),
  includeRaw: z.optional(z.boolean()),
  maxCharsPerMessage: z.optional(z.nullable(z.number().check(z.int(), z.minimum(0), z.maximum(50_000)))),
  maxRawPayloadChars: z.optional(z.nullable(z.number().check(z.int(), z.minimum(1), z.maximum(32768)))),
};

export function isSessionTranscriptSelectionValid(value: Readonly<{
  messageId?: string; cursor?: string | null; direction?: string; limit?: number; projection?: string;
}>): boolean {
  return value.messageId === undefined || (value.cursor === undefined && value.direction === undefined
    && value.limit === undefined && value.projection === undefined);
}
export const exactTranscriptSelectionMessage = 'messageId cannot be combined with cursor, direction, limit or projection';

/** Closed semantic transcript input exposed to PAT/API/SDK callers. */
export const SessionTranscriptGetPublicInputSchema = lazyZodSchema(() => z.omit(z.strictObject(SessionTranscriptGetInputShape),
  { projection: true }).check(z.refine(isSessionTranscriptSelectionValid, { message: exactTranscriptSelectionMessage })));

/**
 * Exact public input for the closed external-shareable transcript projection.
 * `cursor: 'tail'` acquires a no-history continuation at the committed Session
 * sequence, with no items. Subsequent reads use the returned opaque cursor.
 */
export const SessionTranscriptGetExternalShareableInputV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: SessionTranscriptGetInputShape.sessionId,
  projection: SessionTranscriptGetExternalShareableProjectionSchema,
  limit: SessionTranscriptGetInputShape.limit,
  cursor: SessionTranscriptGetInputShape.cursor,
}));
export type SessionTranscriptGetExternalShareableInputV1 = z.infer<
  typeof SessionTranscriptGetExternalShareableInputV1Schema
>;

export const SessionTranscriptGetInputSchema = lazyZodSchema(() => z.looseObject(SessionTranscriptGetInputShape).check(
  z.refine(isSessionTranscriptSelectionValid, { message: exactTranscriptSelectionMessage }), z.superRefine((value, context) => {
  if (value.projection !== 'externalShareableV1') return;
  const allowedKeys = new Set(['sessionId', 'projection', 'cursor', 'limit']);
  for (const key of Object.keys(value)) {
    if (allowedKeys.has(key)) continue;
    context.addIssue({
      code: 'custom',
      path: [key],
      message: `${key} is not accepted by the externalShareableV1 projection`,
    });
  }
})));
export type SessionTranscriptGetInput = z.infer<typeof SessionTranscriptGetInputSchema>;
export const SessionTranscriptSemanticRoleSchema = lazyZodSchema(() => z.enum([
  'user',
  'assistant',
  'tool',
  'event',
  'reasoning',
  'unknown',
]));
export const SessionTranscriptStoredMessageRoleSchema = lazyZodSchema(() => z.enum(['user', 'agent', 'event', 'unknown']));
export const SessionTranscriptGetItemSchema = lazyZodSchema(() => z.strictObject({
  id: z.string(),
  seq: z.optional(z.number().check(z.int(), z.nonnegative())),
  createdAt: z.number().check(z.int(), z.nonnegative()),
  storedMessageRole: z.optional(SessionTranscriptStoredMessageRoleSchema),
  semanticRole: SessionTranscriptSemanticRoleSchema,
  role: SessionTranscriptSemanticRoleSchema,
  kind: z.string(),
  origin: z.optional(ConversationTurnOriginV1Schema),
  provider: z.optional(z.string()),
  text: z.optional(z.string()),
  summary: z.optional(z.string()),
  toolName: z.optional(z.string()),
  callId: z.optional(z.string()),
  raw: z.optional(z.unknown()),
  truncated: z.optional(z.boolean()),
  rawTruncated: z.optional(z.boolean()),
}));
export type SessionTranscriptGetItem = z.infer<typeof SessionTranscriptGetItemSchema>;

export const SessionTranscriptGetSemanticSuccessSchema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true),
  sessionId: z.string().check(z.minLength(1)),
  items: z.readonly(z.array(SessionTranscriptGetItemSchema)),
  nextCursor: z.nullable(z.string().check(z.minLength(1))),
  hasMore: z.boolean(),
  diagnostics: z.strictObject({
    rawRowsScanned: z.number().check(z.int(), z.nonnegative()),
    pagesFetched: z.number().check(z.int(), z.nonnegative()),
    scanLimitReached: z.boolean(),
    payloadTruncations: z.number().check(z.int(), z.nonnegative()),
  }),
}));

export const SessionTranscriptGetExternalShareableResultV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ExternalShareableTranscriptPageV1Schema, {
  ok: z.literal(true),
  sessionId: z.string().check(z.minLength(1)),
  projection: z.literal('externalShareableV1'),
})));

export const SessionTranscriptGetErrorSchema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(false),
  errorCode: z.string().check(z.minLength(1)),
  errorMessage: z.string().check(z.minLength(1)),
  candidates: z.optional(z.readonly(z.array(z.string().check(z.minLength(1))))),
}));

/** Canonical strict result envelope for every session.transcript.get Action path. */
export const SessionTranscriptGetResultSchema = lazyZodSchema(() => z.union([
  SessionTranscriptGetSemanticSuccessSchema,
  SessionTranscriptGetExternalShareableResultV1Schema,
  SessionTranscriptGetErrorSchema,
]));
export type SessionTranscriptGetResult = z.infer<typeof SessionTranscriptGetResultSchema>;
export type SessionTranscriptGetExternalShareableResultV1 = z.infer<
  typeof SessionTranscriptGetExternalShareableResultV1Schema
>;
export type SessionTranscriptGetOutput = SessionTranscriptGetResult;
