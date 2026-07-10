import { z } from 'zod';

import { addSessionSystemRecordPlainContentPayloadIssue } from './sessionSystemRecordCatalog.js';
import { SessionSystemRecordContentSchema } from './sessionSystemRecordContent.js';
import { SessionSystemRecordKindSchema } from './sessionSystemRecordKind.js';
import { SessionSystemRecordNamespaceSchema } from './sessionSystemRecordNamespace.js';

export const SessionSystemRecordSchema = z
  .object({
    id: z.string().trim().min(1),
    accountId: z.string().trim().min(1).optional(),
    sessionId: z.string().trim().min(1),
    namespace: SessionSystemRecordNamespaceSchema,
    kind: SessionSystemRecordKindSchema,
    localId: z.string().trim().min(1),
    content: SessionSystemRecordContentSchema,
    createdAt: z.string().trim().min(1),
    updatedAt: z.string().trim().min(1),
  })
  .passthrough()
  .superRefine(addSessionSystemRecordPlainContentPayloadIssue);
export type SessionSystemRecord = z.infer<typeof SessionSystemRecordSchema>;
