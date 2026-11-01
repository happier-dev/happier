import { z } from 'zod';

import { ACTIVITY_SESSION_SYSTEM_RECORD_KINDS } from './activity/activitySystemRecordKinds.js';
import { MEMORY_SESSION_SYSTEM_RECORD_KINDS } from './memory/memorySystemRecordKinds.js';
import { lazySchema } from '../lazySchema.js';

export const SESSION_SYSTEM_RECORD_KINDS = [
  ...MEMORY_SESSION_SYSTEM_RECORD_KINDS,
  ...ACTIVITY_SESSION_SYSTEM_RECORD_KINDS,
] as const;

export const SessionSystemRecordKindSchema = lazySchema(() => z.enum(SESSION_SYSTEM_RECORD_KINDS));
export type SessionSystemRecordKind = z.infer<typeof SessionSystemRecordKindSchema>;
