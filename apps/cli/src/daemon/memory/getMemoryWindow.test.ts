import { describe, expect, it } from 'vitest';

import type { Credentials, StoredCredentials } from '@/persistence';
import { encryptSessionPayload, type SessionEncryptionContext } from '@/session/transport/encryption/sessionEncryptionContext';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';

describe('getMemoryWindow', () => {
  it('uses semantic extraction for provider messages and excludes events', async () => {
    const { getMemoryWindow } = await import('./getMemoryWindow');

    const credentials: StoredCredentials = { token: 't', encryption: null };

    const window = await getMemoryWindow({
      credentials,
      sessionId: 'sess-provider',
      seqFrom: 1,
      seqTo: 3,
      paddingMessages: 0,
      deps: {
        fetchSessionById: async () => createSessionRecordFixture({
          id: 'sess-provider',
          active: true,
          activeAt: 1,
          metadata: '{}',
          encryptionMode: 'plain',
        }),
        fetchEncryptedTranscriptMessagesPage: async () => ({
          messages: [
            {
              seq: 1,
              createdAt: 1000,
              messageRole: 'agent',
              content: { t: 'plain' as const, v: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'semantic provider window text' } } } },
            },
            {
              seq: 2,
              createdAt: 2000,
              messageRole: 'event',
              content: { t: 'plain' as const, v: { role: 'agent', content: { type: 'codex', data: { type: 'token_count' } } } },
            },
          ],
          hasMore: false,
          nextBeforeSeq: null,
          nextAfterSeq: null,
        }),
      },
    });

    expect(window.snippets).toHaveLength(1);
    expect(window.snippets[0]!.text).toContain('Assistant: semantic provider window text');
    expect(window.snippets[0]!.text).not.toContain('token_count');
  });

  it('decrypts a bounded transcript range and returns a redacted snippet window', async () => {
    const { getMemoryWindow } = await import('./getMemoryWindow');

    const key = new Uint8Array(32).fill(9);
    const credentials: Credentials = {
      token: 't',
      encryption: { type: 'legacy', secret: key },
    };
    const ctx: SessionEncryptionContext = { encryptionKey: key, encryptionVariant: 'legacy' };

    const ciphertext1 = encryptSessionPayload({
      ctx,
      payload: { role: 'user', content: { type: 'text', text: 'hello openclaw' } },
    });
    const ciphertext2 = encryptSessionPayload({
      ctx,
      payload: { role: 'agent', content: { type: 'text', text: 'we discussed memory search' } },
    });

    const window = await getMemoryWindow({
      credentials,
      sessionId: 'sess-1',
      seqFrom: 1,
      seqTo: 2,
      paddingMessages: 0,
      deps: {
        fetchSessionById: async () => createSessionRecordFixture({ id: 'sess-1', active: true, activeAt: 1, metadata: 'b64' }),
        fetchEncryptedTranscriptMessagesPage: async () => ({
          messages: [
            { seq: 1, createdAt: 1000, content: { t: 'encrypted' as const, c: ciphertext1 } },
            { seq: 2, createdAt: 2000, content: { t: 'encrypted' as const, c: ciphertext2 } },
          ],
          hasMore: false,
          nextBeforeSeq: null,
          nextAfterSeq: null,
        }),
      },
    });

    expect(window.v).toBe(1);
    expect(window.snippets.length).toBe(1);
    expect(window.snippets[0]!.text).toContain('hello openclaw');
    expect(window.snippets[0]!.text).toContain('memory search');
    expect(window.citations[0]!.sessionId).toBe('sess-1');
  });

  it('supports plaintext transcript windows (no decrypt)', async () => {
    const { getMemoryWindow } = await import('./getMemoryWindow');

    const key = new Uint8Array(32).fill(7);
    const credentials: Credentials = { token: 't', encryption: { type: 'legacy', secret: key } };

    const window = await getMemoryWindow({
      credentials,
      sessionId: 'sess-plain',
      seqFrom: 1,
      seqTo: 2,
      paddingMessages: 0,
      deps: {
        fetchSessionById: async () => createSessionRecordFixture({
          id: 'sess-plain',
          active: true,
          activeAt: 1,
          metadata: '{}',
          encryptionMode: 'plain',
        }),
        fetchEncryptedTranscriptMessagesPage: async () => ({
          messages: [
            {
              seq: 1,
              createdAt: 1000,
              content: { t: 'plain' as const, v: { role: 'user', content: { type: 'text', text: 'hello' } } },
            },
            {
              seq: 2,
              createdAt: 2000,
              content: { t: 'plain' as const, v: { role: 'agent', content: { type: 'text', text: 'world' } } },
            },
          ],
          hasMore: false,
          nextBeforeSeq: null,
          nextAfterSeq: null,
        }),
      },
    });

    expect(window.v).toBe(1);
    expect(window.snippets.length).toBe(1);
    expect(window.snippets[0]!.text).toContain('User: hello');
    expect(window.snippets[0]!.text).toContain('Assistant: world');
  });

  it('rejects retained encrypted transcript windows when account encryption material is unavailable', async () => {
    const { getMemoryWindow } = await import('./getMemoryWindow');

    const credentials: StoredCredentials = { token: 't', encryption: null };

    await expect(getMemoryWindow({
      credentials,
      sessionId: 'sess-encrypted',
      seqFrom: 1,
      seqTo: 2,
      paddingMessages: 0,
      deps: {
        fetchSessionById: async () => createSessionRecordFixture({
          id: 'sess-encrypted',
          active: true,
          activeAt: 1,
          metadata: 'encrypted',
          encryptionMode: 'e2ee',
        }),
        fetchEncryptedTranscriptMessagesPage: async () => {
          throw new Error('transcript should not be fetched without encryption material');
        },
      },
    })).rejects.toMatchObject({
      code: 'encryption_material_unavailable',
    });
  });
});
