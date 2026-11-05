import { maxCodeUnits } from '../../strings/maxCodeUnits.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';

import { SidechainIdSchema } from '../idsV1.js';
import { ExternalSessionUserProjectionSchema } from '../messages/agentExternalSessionTranscriptRawRecord.js';
import { SessionMessageRoleSchema } from '../messages/sessionMessageRole.js';

export { SidechainIdSchema };

/**
 * The one External Session transcript-item identity contract. The id is an
 * opaque producer value: nonempty, already trimmed (noncanonical whitespace is
 * rejected rather than normalized, so an id can never be silently rewritten
 * into a different or colliding identity) and at most 2,000 code units.
 * Every admission boundary consumes this schema instead of restating a bound
 * that then differs by execution placement.
 */
export const MAX_EXTERNAL_SESSION_TRANSCRIPT_ITEM_ID_CODE_UNITS = 2_000;

export const ExternalSessionTranscriptItemIdV1Schema = lazyZodSchema(() => z.string().check(z.minLength(1), maxCodeUnits(MAX_EXTERNAL_SESSION_TRANSCRIPT_ITEM_ID_CODE_UNITS), z.refine((value) => value === value.trim(), 'External Session transcript item id must already be trimmed.')));
export type ExternalSessionTranscriptItemIdV1 = z.infer<
  typeof ExternalSessionTranscriptItemIdV1Schema
>;

/**
 * The one External Session transcript-item timestamp contract: a safe
 * nonnegative integer in milliseconds. Admission boundaries consume this
 * instead of restating a numeric predicate that then differs by placement.
 */
export const ExternalSessionTranscriptSourceTimestampV1Schema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)));

/** Host-derived presentation text; the containing response owns its byte budget. */
export const ExternalSessionTranscriptDisplayUserTextV1Schema = lazyZodSchema(() => z.string());

/** Exact producer fact selected for deferred inline tool-media materialization. */
export const ExternalSessionToolResultMediaReferenceV1Schema = lazyZodSchema(() => z.strictObject({
  sourceMessageId: ExternalSessionTranscriptItemIdV1Schema,
  toolCallId: ExternalSessionTranscriptItemIdV1Schema,
}));
export type ExternalSessionToolResultMediaReferenceV1 = z.infer<typeof ExternalSessionToolResultMediaReferenceV1Schema>;

/**
 * Canonical known-field owner for one Agent-produced External Session source
 * item. Callers select their epoch-specific identifier, raw-record, and
 * unknown-field policies without independently redeclaring the field census.
 */
export function createExternalSessionTranscriptSourceItemV1Schema<
  IdentifierSchema extends z.ZodMiniType<string>,
  RawSchema extends z.ZodMiniType,
>(options: Readonly<{
  identifier: IdentifierSchema;
  raw: RawSchema;
}>) {
  return z.object({
    id: options.identifier,
    createdAtMs: ExternalSessionTranscriptSourceTimestampV1Schema,
    localId: z.optional(z.nullable(options.identifier)),
    sidechainId: z.optional(z.nullable(SidechainIdSchema)),
    messageRole: z.optional(z.nullable(SessionMessageRoleSchema)),
    userProjection: z.optional(ExternalSessionUserProjectionSchema),
    toolResultMedia: z.optional(ExternalSessionToolResultMediaReferenceV1Schema),
    raw: options.raw,
  });
}

/** Nonvisual native evidence admitted only by an ordered terminal source follow. */
export const ExternalSessionTerminalSourceObservationV1Schema = lazyZodSchema(() => z.strictObject({
  id: ExternalSessionTranscriptItemIdV1Schema,
  createdAtMs: ExternalSessionTranscriptSourceTimestampV1Schema,
  raw: z.strictObject({
    role: z.literal('source_observation'),
    content: StrictJsonValueSchema,
  }),
}));
