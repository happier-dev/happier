import { z } from 'zod';

import { SESSION_SYSTEM_RECORD_MEMORY_NAMESPACE } from './memory/memorySystemRecordKinds.js';

export const SESSION_SYSTEM_RECORD_NAMESPACES = [
  SESSION_SYSTEM_RECORD_MEMORY_NAMESPACE,
] as const;

export const SessionSystemRecordNamespaceSchema = z.enum(SESSION_SYSTEM_RECORD_NAMESPACES);
export type SessionSystemRecordNamespace = z.infer<typeof SessionSystemRecordNamespaceSchema>;
