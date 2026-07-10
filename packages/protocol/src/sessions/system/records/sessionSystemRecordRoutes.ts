import { z } from 'zod';

import {
  addRegisteredSessionSystemRecordKindIssue,
  addSessionSystemRecordPlainContentPayloadIssue,
} from './sessionSystemRecordCatalog.js';
import { SessionSystemRecordContentSchema } from './sessionSystemRecordContent.js';
import { SessionSystemRecordKindSchema } from './sessionSystemRecordKind.js';
import { SessionSystemRecordNamespaceSchema } from './sessionSystemRecordNamespace.js';
import { SessionSystemRecordSchema } from './sessionSystemRecord.js';

const SessionSystemRecordLocalIdSchema = z.string().trim().min(1);
const SessionSystemRecordCursorSchema = z.string().trim().min(1).nullable().optional();
const SessionSystemRecordLimitSchema = z.coerce.number().int().min(1).max(500).default(100);

export const SessionSystemRecordUpsertRequestSchema = z
  .object({
    namespace: SessionSystemRecordNamespaceSchema,
    kind: SessionSystemRecordKindSchema,
    localId: SessionSystemRecordLocalIdSchema,
    content: SessionSystemRecordContentSchema,
  })
  .passthrough()
  .superRefine(addSessionSystemRecordPlainContentPayloadIssue);
export type SessionSystemRecordUpsertRequest = z.infer<typeof SessionSystemRecordUpsertRequestSchema>;

export const SessionSystemRecordUpsertResponseSchema = z
  .object({
    record: SessionSystemRecordSchema,
  })
  .passthrough();
export type SessionSystemRecordUpsertResponse = z.infer<typeof SessionSystemRecordUpsertResponseSchema>;

export const SessionSystemRecordListQuerySchema = z
  .object({
    namespace: SessionSystemRecordNamespaceSchema.optional(),
    kind: SessionSystemRecordKindSchema.optional(),
    localId: SessionSystemRecordLocalIdSchema.optional(),
    limit: SessionSystemRecordLimitSchema,
    cursor: SessionSystemRecordCursorSchema,
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (value.namespace && value.kind) {
      addRegisteredSessionSystemRecordKindIssue({ namespace: value.namespace, kind: value.kind }, ctx);
    }
  });
export type SessionSystemRecordListQuery = z.infer<typeof SessionSystemRecordListQuerySchema>;

export const SessionSystemRecordPageResponseSchema = z
  .object({
    records: z.array(SessionSystemRecordSchema),
    nextCursor: z.string().trim().min(1).nullable(),
    hasNext: z.boolean(),
  })
  .passthrough();
export type SessionSystemRecordPageResponse = z.infer<typeof SessionSystemRecordPageResponseSchema>;

export const SessionSystemRecordLookupQuerySchema = z
  .object({
    namespace: SessionSystemRecordNamespaceSchema,
    localId: SessionSystemRecordLocalIdSchema,
  })
  .passthrough();
export type SessionSystemRecordLookupQuery = z.infer<typeof SessionSystemRecordLookupQuerySchema>;

export const SessionSystemRecordLookupResponseSchema = z
  .object({
    record: SessionSystemRecordSchema.nullable(),
  })
  .passthrough();
export type SessionSystemRecordLookupResponse = z.infer<typeof SessionSystemRecordLookupResponseSchema>;

export const SessionSystemRecordLatestQuerySchema = z
  .object({
    namespace: SessionSystemRecordNamespaceSchema,
    kind: SessionSystemRecordKindSchema,
  })
  .passthrough()
  .superRefine(addRegisteredSessionSystemRecordKindIssue);
export type SessionSystemRecordLatestQuery = z.infer<typeof SessionSystemRecordLatestQuerySchema>;

export const SessionSystemRecordLatestResponseSchema = z
  .object({
    record: SessionSystemRecordSchema.nullable(),
  })
  .passthrough();
export type SessionSystemRecordLatestResponse = z.infer<typeof SessionSystemRecordLatestResponseSchema>;
