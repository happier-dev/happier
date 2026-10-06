import { MEMORY_SESSION_SYSTEM_RECORD_KINDS, SESSION_SYSTEM_RECORD_MEMORY_NAMESPACE } from '@happier-dev/protocol/sessions/system/records/memory/memorySystemRecordKinds';
import { SessionSummaryShardV1Schema } from '@happier-dev/protocol/messages/structured/sessionSummaryShardV1';
import { SessionSynopsisV1Schema } from '@happier-dev/protocol/messages/structured/sessionSynopsisV1';
import type { MemorySessionSystemRecordKind, SessionSystemRecordContent, SessionSystemRecordNamespace, SessionSummaryShardV1, SessionSynopsisV1 } from '@happier-dev/protocol';

import {
  openSessionStoredContent,
  sealSessionStoredContent,
  type SessionEncryptionContext,
  type SessionStoredContentCryptoContext,
  type SessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionStoredContentCodec';
import { AccountEncryptionMaterialUnavailableError } from '@/api/client/encryptionKey';

export const MEMORY_SYSTEM_RECORD_NAMESPACE = SESSION_SYSTEM_RECORD_MEMORY_NAMESPACE satisfies SessionSystemRecordNamespace;

export const MEMORY_SYSTEM_RECORD_KINDS = {
  summaryShard: MEMORY_SESSION_SYSTEM_RECORD_KINDS[0],
  synopsis: MEMORY_SESSION_SYSTEM_RECORD_KINDS[1],
} as const satisfies Record<string, MemorySessionSystemRecordKind>;

export type MemorySystemRecordPayload =
  | SessionSummaryShardV1
  | SessionSynopsisV1;

function requireStoredContentContext(params: Readonly<{
  mode: SessionStoredContentEncryptionMode;
  ctx?: SessionEncryptionContext;
}>): SessionStoredContentCryptoContext {
  if (params.mode === 'plain') return { mode: 'plain', ctx: null };
  if (!params.ctx) throw new AccountEncryptionMaterialUnavailableError();
  return { mode: 'e2ee', ctx: params.ctx };
}

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
  return sealSessionStoredContent({
    ...requireStoredContentContext(params),
    payload,
  });
}

export function openMemorySystemRecordPayload(params: Readonly<{
  namespace?: SessionSystemRecordNamespace;
  mode: SessionStoredContentEncryptionMode;
  kind: MemorySessionSystemRecordKind;
  content: unknown;
  ctx?: SessionEncryptionContext;
}>): MemorySystemRecordPayload | null {
  if (params.namespace && params.namespace !== MEMORY_SYSTEM_RECORD_NAMESPACE) return null;
  try {
    const decrypted = openSessionStoredContent({
      ...requireStoredContentContext(params),
      content: params.content,
    });
    const payload = parseMemoryPayload(params.kind, decrypted);
    if (!payload) {
      throw new AccountEncryptionMaterialUnavailableError();
    }
    return payload;
  } catch {
    throw new AccountEncryptionMaterialUnavailableError();
  }
}
