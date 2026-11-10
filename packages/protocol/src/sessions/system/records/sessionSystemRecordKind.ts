import { USAGE_SESSION_WORK_FACTS_SYSTEM_RECORD_ADDRESS } from '../../../usage/usageTimingV1.js';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

import { ACTIVITY_SESSION_SYSTEM_RECORD_KINDS } from './activity/activitySystemRecordKinds.js';
import { MEMORY_SESSION_SYSTEM_RECORD_KINDS } from './memory/memorySystemRecordKinds.js';
import { SESSION_PERMISSION_SYSTEM_RECORD_KINDS } from '../../permissions/permissionSystemRecordKinds.js';

export const SESSION_SYSTEM_RECORD_KINDS = [
  ...MEMORY_SESSION_SYSTEM_RECORD_KINDS,
  USAGE_SESSION_WORK_FACTS_SYSTEM_RECORD_ADDRESS.kind,
  'layout.v1',
  'item.v1',
  ...ACTIVITY_SESSION_SYSTEM_RECORD_KINDS,
  ...SESSION_PERMISSION_SYSTEM_RECORD_KINDS,
] as const;

export const SessionSystemRecordKindSchema = lazyZodSchema(() => z.enum(SESSION_SYSTEM_RECORD_KINDS));
export type SessionSystemRecordKind = z.infer<typeof SessionSystemRecordKindSchema>;
