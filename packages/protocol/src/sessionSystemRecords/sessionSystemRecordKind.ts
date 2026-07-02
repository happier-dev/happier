import { z } from 'zod';

import { MEMORY_SESSION_SYSTEM_RECORD_KINDS, MemorySessionSystemRecordKindSchema } from './memory/memorySystemRecordKinds.js';

export const SESSION_SYSTEM_RECORD_KINDS = [
  ...MEMORY_SESSION_SYSTEM_RECORD_KINDS,
] as const;

export const SessionSystemRecordKindSchema = MemorySessionSystemRecordKindSchema;
export type SessionSystemRecordKind = z.infer<typeof SessionSystemRecordKindSchema>;
