import { describe, expect, it } from 'vitest';

import type { Credentials } from '@/persistence';
import { decryptSessionPayload, type SessionEncryptionContext } from '@/sessionControl/sessionEncryptionContext';

describe('commitMemoryHintArtifacts', () => {
  it('builds encrypted structured transcript messages with deterministic localIds', async () => {
    const { commitMemoryHintArtifacts } = await import('./commitMemoryHintArtifacts');

    const key = new Uint8Array(32).fill(3);
    const credentials: Credentials = { token: 't', encryption: { type: 'legacy', secret: key } };
    const ctx: SessionEncryptionContext = { encryptionKey: key, encryptionVariant: 'legacy' };

    const writes: Array<{ localId: string; ciphertext: string }> = [];

    await commitMemoryHintArtifacts({
      credentials,
      sessionId: 'sess-1',
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
      synopsis: null,
      deps: {
        commitSessionEncryptedMessage: async ({ localId, ciphertext }) => {
          writes.push({ localId, ciphertext });
          return { didWrite: true, messageId: 'm1', seq: 3, createdAt: 2000 };
        },
      },
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]!.localId).toBe('memory:summary_shard:v1:1-2');

    const decrypted = decryptSessionPayload({ ctx, ciphertextBase64: writes[0]!.ciphertext }) as any;
    expect(decrypted?.meta?.happier?.kind).toBe('session_summary_shard.v1');
    expect(decrypted?.meta?.happier?.payload?.summary).toContain('OpenClaw');
  });
});
