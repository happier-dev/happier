import {
  MEMORY_SESSION_SYSTEM_RECORD_KINDS,
  SESSION_SYSTEM_RECORD_MEMORY_NAMESPACE,
  SessionSummaryShardV1Schema,
  SessionSynopsisV1Schema,
  type MemorySessionSystemRecordKind,
  type SessionSystemRecordContent,
  type SessionSystemRecordNamespace,
  type SessionSummaryShardV1,
  type SessionSynopsisV1,
} from '@happier-dev/protocol';

import {
  decryptSessionPayload,
  encryptSessionPayload,
  type SessionEncryptionContext,
  type SessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';

export const MEMORY_SYSTEM_RECORD_NAMESPACE = SESSION_SYSTEM_RECORD_MEMORY_NAMESPACE satisfies SessionSystemRecordNamespace;

export const MEMORY_SYSTEM_RECORD_KINDS = {
  summaryShard: MEMORY_SESSION_SYSTEM_RECORD_KINDS[0],
  synopsis: MEMORY_SESSION_SYSTEM_RECORD_KINDS[1],
} as const satisfies Record<string, MemorySessionSystemRecordKind>;

export type MemorySystemRecordPayload =
  | SessionSummaryShardV1
  | SessionSynopsisV1;

export function buildMemorySummaryShardSystemRecordLocalId(params: Readonly<{ seqFrom: number; seqTo: number }>): string {
  const seqFrom = Math.max(0, Math.trunc(params.seqFrom));
  const seqTo = Math.max(0, Math.trunc(params.seqTo));
  return `memory:summary_shard:v1:${seqFrom}-${seqTo}`;
}

export function buildMemorySynopsisSystemRecordLocalId(params: Readonly<{ seqTo: number }>): string {
  const seqTo = Math.max(0, Math.trunc(params.seqTo));
  return `memory:synopsis:v1:${seqTo}`;
}

function parseMemoryPayload(kind: MemorySessionSystemRecordKind, payload: unknown): MemorySystemRecordPayload | null {
  if (kind === MEMORY_SYSTEM_RECORD_KINDS.summaryShard) {
    const parsed = SessionSummaryShardV1Schema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  }
  if (kind === MEMORY_SYSTEM_RECORD_KINDS.synopsis) {
    const parsed = SessionSynopsisV1Schema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  }
  return null;
}

export function sealMemorySystemRecordPayload(params: Readonly<{
  mode: SessionStoredContentEncryptionMode;
  ctx?: SessionEncryptionContext;
  kind: MemorySessionSystemRecordKind;
  payload: MemorySystemRecordPayload;
}>): SessionSystemRecordContent {
  const payload = parseMemoryPayload(params.kind, params.payload);
  if (!payload) {
    throw new Error(`Invalid memory system record payload for kind ${params.kind}`);
  }
  if (params.mode === 'plain') {
    return { t: 'plain', v: payload };
  }
  if (!params.ctx) {
    throw new Error('Missing session encryption context for encrypted memory system record');
  }
  return {
    t: 'encrypted',
    c: encryptSessionPayload({ ctx: params.ctx, payload }),
  };
}

export function openMemorySystemRecordPayload(params: Readonly<{
  namespace?: SessionSystemRecordNamespace;
  kind: MemorySessionSystemRecordKind;
  content: SessionSystemRecordContent;
  ctx?: SessionEncryptionContext;
}>): MemorySystemRecordPayload | null {
  if (params.namespace && params.namespace !== MEMORY_SYSTEM_RECORD_NAMESPACE) return null;
  if (params.content.t === 'plain') {
    return parseMemoryPayload(params.kind, params.content.v);
  }
  if (!params.ctx) return null;
  try {
    const decrypted = decryptSessionPayload({ ctx: params.ctx, ciphertextBase64: params.content.c });
    return parseMemoryPayload(params.kind, decrypted);
  } catch {
    return null;
  }
}
