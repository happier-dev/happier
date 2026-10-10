import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod';

import { ACTIVITY_SESSION_SYSTEM_RECORD_KINDS } from './activity/activitySystemRecordKinds.js';
import { MEMORY_SESSION_SYSTEM_RECORD_KINDS } from './memory/memorySystemRecordKinds.js';
import { SESSION_PERMISSION_SYSTEM_RECORD_KINDS } from '../../permissions/permissionSystemRecordKinds.js';

export const SESSION_SYSTEM_RECORD_KINDS = [
  ...MEMORY_SESSION_SYSTEM_RECORD_KINDS,
  'layout.v1',
  'item.v1',
  ...ACTIVITY_SESSION_SYSTEM_RECORD_KINDS,
  ...SESSION_PERMISSION_SYSTEM_RECORD_KINDS,
] as const;

export const SessionSystemRecordKindSchema = lazyZodSchema(() => z.enum(SESSION_SYSTEM_RECORD_KINDS));
export type SessionSystemRecordKind = z.infer<typeof SessionSystemRecordKindSchema>;
