import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod';

import { SESSION_SYSTEM_RECORD_ACTIVITY_NAMESPACE } from './activity/activitySystemRecordKinds.js';
import { SESSION_SYSTEM_RECORD_MEMORY_NAMESPACE } from './memory/memorySystemRecordKinds.js';
import { SESSION_PERMISSION_SYSTEM_RECORD_NAMESPACE } from '../../permissions/permissionSystemRecordKinds.js';

export const SESSION_SYSTEM_RECORD_NAMESPACES = [
  SESSION_SYSTEM_RECORD_MEMORY_NAMESPACE,
  'surface',
  SESSION_SYSTEM_RECORD_ACTIVITY_NAMESPACE,
  SESSION_PERMISSION_SYSTEM_RECORD_NAMESPACE,
] as const;

export const SessionSystemRecordNamespaceSchema = lazyZodSchema(() => z.enum(SESSION_SYSTEM_RECORD_NAMESPACES));
export type SessionSystemRecordNamespace = z.infer<typeof SessionSystemRecordNamespaceSchema>;
