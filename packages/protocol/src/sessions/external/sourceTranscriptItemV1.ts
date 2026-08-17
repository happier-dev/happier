import { z } from 'zod';

import { SidechainIdSchema } from '../idsV1.js';
import { ExternalSessionUserProjectionSchema } from '../messages/agentExternalSessionTranscriptRawRecord.js';
import { SessionMessageRoleSchema } from '../messages/sessionMessageRole.js';

const ExternalSessionTranscriptSourceTimestampV1Schema = z.number()
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
