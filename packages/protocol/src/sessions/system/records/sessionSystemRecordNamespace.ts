import { USAGE_SESSION_WORK_FACTS_SYSTEM_RECORD_ADDRESS } from '../../../usage/usageTimingV1.js';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

import { SESSION_SYSTEM_RECORD_ACTIVITY_NAMESPACE } from './activity/activitySystemRecordKinds.js';
import { SESSION_SYSTEM_RECORD_MEMORY_NAMESPACE } from './memory/memorySystemRecordKinds.js';
import { SESSION_PERMISSION_SYSTEM_RECORD_NAMESPACE } from '../../permissions/permissionSystemRecordKinds.js';

export const SESSION_SYSTEM_RECORD_NAMESPACES = [
  SESSION_SYSTEM_RECORD_MEMORY_NAMESPACE,
  USAGE_SESSION_WORK_FACTS_SYSTEM_RECORD_ADDRESS.namespace,
  'surface',
  SESSION_SYSTEM_RECORD_ACTIVITY_NAMESPACE,
  SESSION_PERMISSION_SYSTEM_RECORD_NAMESPACE,
] as const;

export const SessionSystemRecordNamespaceSchema = lazyZodSchema(() => z.enum(SESSION_SYSTEM_RECORD_NAMESPACES));
export type SessionSystemRecordNamespace = z.infer<typeof SessionSystemRecordNamespaceSchema>;
