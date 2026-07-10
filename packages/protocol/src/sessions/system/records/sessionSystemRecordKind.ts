import { z } from 'zod';

import { ACTIVITY_SESSION_SYSTEM_RECORD_KINDS } from './activity/activitySystemRecordKinds.js';
import { MEMORY_SESSION_SYSTEM_RECORD_KINDS } from './memory/memorySystemRecordKinds.js';

export const SESSION_SYSTEM_RECORD_KINDS = [
  ...MEMORY_SESSION_SYSTEM_RECORD_KINDS,
  ...ACTIVITY_SESSION_SYSTEM_RECORD_KINDS,
] as const;

export const SessionSystemRecordKindSchema = z.enum(SESSION_SYSTEM_RECORD_KINDS);
export type SessionSystemRecordKind = z.infer<typeof SessionSystemRecordKindSchema>;
