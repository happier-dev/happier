import { z } from 'zod';

import { SESSION_SYSTEM_RECORD_ACTIVITY_NAMESPACE } from './activity/activitySystemRecordKinds.js';
import { SESSION_SYSTEM_RECORD_MEMORY_NAMESPACE } from './memory/memorySystemRecordKinds.js';
import { lazySchema } from '../lazySchema.js';

export const SESSION_SYSTEM_RECORD_NAMESPACES = [
  SESSION_SYSTEM_RECORD_MEMORY_NAMESPACE,
  SESSION_SYSTEM_RECORD_ACTIVITY_NAMESPACE,
] as const;

export const SessionSystemRecordNamespaceSchema = lazySchema(() => z.enum(SESSION_SYSTEM_RECORD_NAMESPACES));
export type SessionSystemRecordNamespace = z.infer<typeof SessionSystemRecordNamespaceSchema>;
