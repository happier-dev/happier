import { z } from 'zod';
import { lazySchema } from '../../lazySchema.js';

export const SESSION_SYSTEM_RECORD_MEMORY_NAMESPACE = 'memory' as const;

export const MEMORY_SESSION_SYSTEM_RECORD_KINDS = [
  'summary_shard.v1',
  'synopsis.v1',
] as const;

export const MemorySessionSystemRecordKindSchema = lazySchema(() => z.enum(MEMORY_SESSION_SYSTEM_RECORD_KINDS));
export type MemorySessionSystemRecordKind = z.infer<typeof MemorySessionSystemRecordKindSchema>;
