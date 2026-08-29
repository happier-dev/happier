import { z } from 'zod';

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

export const ExternalSessionTranscriptItemIdV1Schema = z.string()
  .min(1)
  .max(MAX_EXTERNAL_SESSION_TRANSCRIPT_ITEM_ID_CODE_UNITS)
  .refine(
    (value) => value === value.trim(),
    'External Session transcript item id must already be trimmed.',
  );
export type ExternalSessionTranscriptItemIdV1 = z.infer<
  typeof ExternalSessionTranscriptItemIdV1Schema
>;

/**
 * The one External Session transcript-item timestamp contract: a safe
 * nonnegative integer in milliseconds. Admission boundaries consume this
 * instead of restating a numeric predicate that then differs by placement.
 */
export const ExternalSessionTranscriptSourceTimestampV1Schema = z.number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

/**
 * Canonical known-field owner for one Agent-produced External Session source
 * item. Callers select their epoch-specific identifier, raw-record, and
 * unknown-field policies without independently redeclaring the field census.
 */
export function createExternalSessionTranscriptSourceItemV1Schema<
  IdentifierSchema extends z.ZodType<string>,
  RawSchema extends z.ZodType,
>(options: Readonly<{
  identifier: IdentifierSchema;
  raw: RawSchema;
}>) {
  return z.object({
    id: options.identifier,
    createdAtMs: ExternalSessionTranscriptSourceTimestampV1Schema,
    localId: options.identifier.nullable().optional(),
    sidechainId: SidechainIdSchema.nullable().optional(),
    messageRole: SessionMessageRoleSchema.nullable().optional(),
    userProjection: ExternalSessionUserProjectionSchema.optional(),
    raw: options.raw,
  });
}
