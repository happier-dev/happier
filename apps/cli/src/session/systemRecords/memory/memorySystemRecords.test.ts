import { describe, expect, it } from 'vitest';

import type { SessionSummaryShardV1, SessionSynopsisV1 } from '@happier-dev/protocol';

import {
  decryptSessionPayload,
  type SessionEncryptionContext,
} from '@/session/transport/encryption/sessionEncryptionContext';

describe('memory system record helpers', () => {
  it('builds deterministic memory system-record localIds and namespace-relative kinds', async () => {
    const {
      MEMORY_SYSTEM_RECORD_KINDS,
      buildMemorySummaryShardSystemRecordLocalId,
      buildMemorySynopsisSystemRecordLocalId,
    } = await import('./memorySystemRecords');

    expect(MEMORY_SYSTEM_RECORD_KINDS.summaryShard).toBe('summary_shard.v1');
    expect(MEMORY_SYSTEM_RECORD_KINDS.synopsis).toBe('synopsis.v1');
    expect(buildMemorySummaryShardSystemRecordLocalId({ seqFrom: 1, seqTo: 10 })).toBe('memory:summary_shard:v1:1-10');
    expect(buildMemorySynopsisSystemRecordLocalId({ seqTo: 10 })).toBe('memory:synopsis:v1:10');
  });

  it('seals and opens plaintext summary shard payloads without transcript wrappers', async () => {
    const {
      MEMORY_SYSTEM_RECORD_NAMESPACE,
      MEMORY_SYSTEM_RECORD_KINDS,
      openMemorySystemRecordPayload,
      sealMemorySystemRecordPayload,
    } = await import('./memorySystemRecords');

    const payload: SessionSummaryShardV1 = {
      v: 1,
      seqFrom: 1,
      seqTo: 2,
      createdAtFromMs: 1000,
      createdAtToMs: 2000,
      summary: 'Discussed OpenClaw.',
      keywords: ['openclaw'],
      entities: [],
      decisions: [],
    };

    const content = sealMemorySystemRecordPayload({
      mode: 'plain',
      kind: MEMORY_SYSTEM_RECORD_KINDS.summaryShard,
      payload,
    });

    expect(content).toEqual({ t: 'plain', v: payload });
    expect(openMemorySystemRecordPayload({
      namespace: MEMORY_SYSTEM_RECORD_NAMESPACE,
      kind: MEMORY_SYSTEM_RECORD_KINDS.summaryShard,
      content,
    })).toEqual(payload);
  });

  it('seals encrypted synopsis payloads and opens them with the session encryption context', async () => {
    const {
      MEMORY_SYSTEM_RECORD_KINDS,
      openMemorySystemRecordPayload,
      sealMemorySystemRecordPayload,
    } = await import('./memorySystemRecords');

    const key = new Uint8Array(32).fill(7);
    const ctx: SessionEncryptionContext = { encryptionKey: key, encryptionVariant: 'legacy' };
    const payload: SessionSynopsisV1 = {
      v: 1,
      seqTo: 25,
      updatedAtMs: 12345,
      synopsis: 'The session is about memory system records.',
    };

    const content = sealMemorySystemRecordPayload({
      mode: 'e2ee',
      ctx,
      kind: MEMORY_SYSTEM_RECORD_KINDS.synopsis,
      payload,
    });

    expect(content.t).toBe('encrypted');
    if (content.t !== 'encrypted') return;
    expect(decryptSessionPayload({ ctx, ciphertextBase64: content.c })).toEqual(payload);
    expect(openMemorySystemRecordPayload({
      kind: MEMORY_SYSTEM_RECORD_KINDS.synopsis,
      content,
      ctx,
    })).toEqual(payload);
  });
});
