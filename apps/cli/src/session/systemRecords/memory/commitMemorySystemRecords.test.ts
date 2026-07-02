import { describe, expect, it } from 'vitest';

import type { Credentials } from '@/persistence';
import {
  decryptSessionPayload,
  type SessionEncryptionContext,
} from '@/session/transport/encryption/sessionEncryptionContext';

describe('commitMemorySystemRecords', () => {
  it('upserts memory summary and synopsis records without transcript message commits', async () => {
    const { commitMemorySystemRecords } = await import('./commitMemorySystemRecords');

    const key = new Uint8Array(32).fill(3);
    const credentials: Credentials = { token: 't', encryption: { type: 'legacy', secret: key } };
    const ctx: SessionEncryptionContext = { encryptionKey: key, encryptionVariant: 'legacy' };

    const writes: Array<{
      namespace: string;
      kind: string;
      localId: string;
      content: { t: 'encrypted'; c: string } | { t: 'plain'; v: unknown };
    }> = [];

    await commitMemorySystemRecords({
      credentials,
      sessionId: 'sess-1',
      mode: 'e2ee',
      ctx,
      shard: {
        sessionId: 'sess-1',
        payload: {
          v: 1,
          seqFrom: 1,
          seqTo: 2,
          createdAtFromMs: 1000,
          createdAtToMs: 2000,
          summary: 'Discussed OpenClaw.',
          keywords: ['openclaw'],
          entities: [],
          decisions: [],
        },
      },
      synopsis: {
        sessionId: 'sess-1',
        payload: {
          v: 1,
          seqTo: 2,
          updatedAtMs: 3000,
          synopsis: 'OpenClaw memory notes.',
        },
      },
      deps: {
        upsertSessionSystemRecord: async (record) => {
          writes.push({
            namespace: record.namespace,
            kind: record.kind,
            localId: record.localId,
            content: record.content,
          });
          return {
            id: `record-${writes.length}`,
            sessionId: record.sessionId,
            namespace: record.namespace,
            kind: record.kind,
            localId: record.localId,
            content: record.content,
            createdAt: '2026-05-19T00:00:00.000Z',
            updatedAt: '2026-05-19T00:00:00.000Z',
          };
        },
      },
    });

    expect(writes).toHaveLength(2);
    expect(writes.map((write) => [write.namespace, write.kind, write.localId])).toEqual([
      ['memory', 'summary_shard.v1', 'memory:summary_shard:v1:1-2'],
      ['memory', 'synopsis.v1', 'memory:synopsis:v1:2'],
    ]);
    expect(writes[0]!.content.t).toBe('encrypted');
    if (writes[0]!.content.t !== 'encrypted') return;
    expect(decryptSessionPayload({ ctx, ciphertextBase64: writes[0]!.content.c })).toMatchObject({
      v: 1,
      summary: 'Discussed OpenClaw.',
    });
  });
});
