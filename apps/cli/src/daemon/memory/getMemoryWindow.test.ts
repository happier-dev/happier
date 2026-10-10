import { describe, expect, it, vi } from 'vitest';

import type { Credentials, StoredCredentials } from '@/persistence';
import { encryptSessionPayload, type SessionEncryptionContext } from '@/session/transport/encryption/sessionEncryptionContext';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { getMemoryWindow } from './getMemoryWindow';

describe('getMemoryWindow', () => {
  it('reads a native hit through transcript pages using opaque cursors and source item identity', async () => {
    const source = { type: 'external_transcript' as const, agentId: 'pi', sourceKey: 'pi-source', nativeSessionId: 'native' };
    const calls: (string | undefined)[] = [];
    const window = await getMemoryWindow({ source, sourceItemId: 'wanted', paddingMessages: 0,
      fetchExternalTranscriptPage: async request => {
        calls.push(request.cursor);
        const id = request.cursor ? 'wanted' : 'other';
        return { items: [{ id,
          raw: { role: 'user', content: { type: 'text', text: request.cursor ? 'quartz native message' : 'unrelated' } },
          createdAtMs: 1 }], nextCursor: request.cursor ? null : 'opaque-next', hasMore: !request.cursor };
      },
    });
    expect(calls).toEqual([undefined, 'opaque-next']);
    expect(window.snippets).toEqual([]);
    expect(window.externalSnippets).toEqual([expect.objectContaining({ source, sourceItemId: 'wanted', text: expect.stringContaining('quartz native message') })]);
  });
  it('passes the caller signal to Session metadata and transcript HTTP boundaries', async () => {
    const controller = new AbortController();
    const fetchSessionById = vi.fn(async () => createSessionRecordFixture({
      id: 'sess-signal', active: true, activeAt: 1, metadata: 'b64', encryptionMode: 'plain',
    }));
    const fetchEncryptedTranscriptMessagesPage = vi.fn(async () => ({
      messages: [], hasMore: false, nextBeforeSeq: null, nextAfterSeq: null,
    }));

    await getMemoryWindow({
      credentials: { token: 'token', encryption: null },
      sessionId: 'sess-signal',
      seqFrom: 1,
      seqTo: 1,
      paddingMessages: 0,
      signal: controller.signal,
      deps: { fetchSessionById, fetchEncryptedTranscriptMessagesPage },
    });

    expect(fetchSessionById).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
    expect(fetchEncryptedTranscriptMessagesPage).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
  });
  it('uses semantic extraction for provider messages and excludes events', async () => {

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
