import { describe, expect, it } from 'vitest';

import type { Credentials } from '@/persistence';
import { encryptSessionPayload, type SessionEncryptionContext } from '@/sessionControl/sessionEncryptionContext';
import { makeSessionFixtureRow } from '@/sessionControl/testFixtures';

describe('getMemoryWindow', () => {
  it('decrypts a bounded transcript range and returns a redacted snippet window', async () => {
    const { getMemoryWindow } = await import('./getMemoryWindow');

    const key = new Uint8Array(32).fill(7);
    const credentials: Credentials = { token: 't', encryption: { type: 'legacy', secret: key } };
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
        fetchSessionById: async () => makeSessionFixtureRow({ id: 'sess-1', active: true, activeAt: 1, metadata: 'b64' }),
        fetchEncryptedTranscriptRange: async () => ({
          ok: true as const,
          rows: [
            { seq: 1, createdAt: 1000, content: { t: 'encrypted' as const, c: ciphertext1 } },
            { seq: 2, createdAt: 2000, content: { t: 'encrypted' as const, c: ciphertext2 } },
          ],
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
        fetchSessionById: async () => makeSessionFixtureRow({ id: 'sess-plain', active: true, activeAt: 1, metadata: '{}' }),
        fetchEncryptedTranscriptRange: async () => ({
          ok: true as const,
          rows: [
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
        }),
      },
    });

    expect(window.v).toBe(1);
    expect(window.snippets.length).toBe(1);
    expect(window.snippets[0]!.text).toContain('User: hello');
    expect(window.snippets[0]!.text).toContain('Assistant: world');
  });
});
