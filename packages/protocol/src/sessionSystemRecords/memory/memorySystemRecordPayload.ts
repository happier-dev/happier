import { z } from 'zod';

import { SessionSummaryShardV1Schema } from '../../structuredMessages/sessionSummaryShardV1.js';
import { SessionSynopsisV1Schema } from '../../structuredMessages/sessionSynopsisV1.js';
import { MemorySessionSystemRecordKindSchema } from './memorySystemRecordKinds.js';
import { lazySchema } from '../../lazySchema.js';

export const MemorySummaryShardSystemRecordPayloadSchema = lazySchema(() => z
  .object({
    kind: z.literal('summary_shard.v1'),
    payload: SessionSummaryShardV1Schema,
  })
  .passthrough());
export type MemorySummaryShardSystemRecordPayload = z.infer<typeof MemorySummaryShardSystemRecordPayloadSchema>;

export const MemorySynopsisSystemRecordPayloadSchema = lazySchema(() => z
  .object({
    kind: z.literal('synopsis.v1'),
    payload: SessionSynopsisV1Schema,
  })
  .passthrough());
export type MemorySynopsisSystemRecordPayload = z.infer<typeof MemorySynopsisSystemRecordPayloadSchema>;

export const MemorySessionSystemRecordPayloadSchema = lazySchema(() => z.discriminatedUnion('kind', [
  MemorySummaryShardSystemRecordPayloadSchema,
  MemorySynopsisSystemRecordPayloadSchema,
]));
export type MemorySessionSystemRecordPayload = z.infer<typeof MemorySessionSystemRecordPayloadSchema>;

export const MemorySessionSystemRecordRawPayloadSchema = lazySchema(() => z.union([
  SessionSummaryShardV1Schema,
  SessionSynopsisV1Schema,
]));
export type MemorySessionSystemRecordRawPayload = z.infer<typeof MemorySessionSystemRecordRawPayloadSchema>;

export function isMemorySessionSystemRecordKind(value: string): value is z.infer<typeof MemorySessionSystemRecordKindSchema> {
  return MemorySessionSystemRecordKindSchema.safeParse(value).success;
}
