import { z } from 'zod';

import { SessionSummaryShardV1Schema } from '../structuredMessages/sessionSummaryShardV1.js';
import { SessionSynopsisV1Schema } from '../structuredMessages/sessionSynopsisV1.js';
import { SESSION_SYSTEM_RECORD_MEMORY_NAMESPACE } from './memory/memorySystemRecordKinds.js';

export type SessionSystemRecordKindDefinition = Readonly<{
  payloadSchema: z.ZodType<unknown>;
}>;

export type SessionSystemRecordNamespaceDefinition = Readonly<{
  kinds: Readonly<Record<string, SessionSystemRecordKindDefinition>>;
}>;

export type SessionSystemRecordCatalog = Readonly<Record<string, SessionSystemRecordNamespaceDefinition>>;

function defineSessionSystemRecordCatalog<const Catalog extends SessionSystemRecordCatalog>(catalog: Catalog): Catalog {
  return catalog;
}

export const SESSION_SYSTEM_RECORD_CATALOG = defineSessionSystemRecordCatalog({
  [SESSION_SYSTEM_RECORD_MEMORY_NAMESPACE]: {
    kinds: {
      'summary_shard.v1': {
        payloadSchema: SessionSummaryShardV1Schema,
      },
      'synopsis.v1': {
        payloadSchema: SessionSynopsisV1Schema,
      },
    },
  },
});

export function getSessionSystemRecordPayloadSchema(namespace: string, kind: string): z.ZodType<unknown> | null {
  const catalog: SessionSystemRecordCatalog = SESSION_SYSTEM_RECORD_CATALOG;
  return catalog[namespace]?.kinds[kind]?.payloadSchema ?? null;
}

export function isRegisteredSessionSystemRecordKind(namespace: string, kind: string): boolean {
  return getSessionSystemRecordPayloadSchema(namespace, kind) !== null;
}

export function addRegisteredSessionSystemRecordKindIssue(value: { namespace: string; kind: string }, ctx: z.RefinementCtx): void {
  if (!isRegisteredSessionSystemRecordKind(value.namespace, value.kind)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Unregistered session system record namespace/kind pair',
      path: ['kind'],
    });
  }
}

export function addSessionSystemRecordPlainContentPayloadIssue(
  value: { namespace: string; kind: string; content?: unknown },
  ctx: z.RefinementCtx,
): void {
  addRegisteredSessionSystemRecordKindIssue(value, ctx);

  const content = value.content;
  if (!content || typeof content !== 'object' || Array.isArray(content)) return;
  const record = content as Record<string, unknown>;
  if (record.t !== 'plain') return;

  const payloadSchema = getSessionSystemRecordPayloadSchema(value.namespace, value.kind);
  if (!payloadSchema) return;

  const parsed = payloadSchema.safeParse(record.v);
  if (parsed.success) return;

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'Plain session system record content does not match registered namespace/kind payload schema',
    path: ['content', 'v'],
  });
}
