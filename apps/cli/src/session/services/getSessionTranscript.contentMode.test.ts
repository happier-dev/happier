import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { getSessionTranscript } from './getSessionTranscript';
import { getSessionEvents } from './getSessionEvents';

describe('Session semantic readers content mode', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['plain', 'e2ee'] as const)('establishes the %s no-history tail without opening or publishing transcript content', async encryptionMode => {
    const sessionId = 'c1234567890123456789012345';
    const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'e2ee' }) };
      if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: createSessionRecordFixture({ id: sessionId, encryptionMode, seq: 4 }) } };
      throw new Error(`A tail acquisition must not read transcript rows: ${path}`);
    });
    const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };
    const input = { idOrPrefix: sessionId, projection: 'externalShareableV1' as const, cursor: 'tail' };
    expect(await getSessionTranscript({ ...input, credentials })).toEqual({
      ok: true, sessionId, projection: 'externalShareableV1', items: [], nextCursor: '4', scannedThroughSeq: 4, hasMore: false,
    });
    if (encryptionMode === 'e2ee') {
      expect(await getSessionTranscript({ ...input, credentials: { token: 'token', encryption: null } }))
        .toMatchObject({ ok: false, errorCode: 'encryption_material_unavailable' });
    }
    expect(get.mock.calls.some(([url]) => new URL(String(url)).pathname.endsWith('/messages'))).toBe(false);
  });

  it.each(['plain', 'e2ee'] as const)('rejects mismatched %s transcript and event rows before semantic extraction', async (encryptionMode) => {
    const sessionId = 'c1234567890123456789012345';
    vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') {
        return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'e2ee' }) };
      }
      if (path === `/v2/sessions/${sessionId}`) {
        expect(options?.headers?.['X-Happier-Request-Purpose']).toBe('session-detail:session-content');
        return { status: 200, data: { session: createSessionRecordFixture({ id: sessionId, encryptionMode }) } };
      }
      if (path === `/v1/sessions/${sessionId}/messages`) {
        return { status: 200, data: { messages: [{ id: 'message-1', seq: 1, createdAt: 1, content: encryptionMode === 'plain'
          ? { t: 'encrypted', c: 'unopenable' }
          : { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'do not disclose' } } },
        }], hasMore: false } };
      }
      throw new Error(`Unexpected HTTP request: ${path}`);
    });
    const params = {
      credentials: { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } },
      idOrPrefix: sessionId,
    };
    await expect(getSessionTranscript(params)).rejects.toMatchObject({ code: 'session_content_mode_mismatch' });
    await expect(getSessionTranscript({ ...params, messageId: 'message-1' })).rejects.toMatchObject({ code: 'session_content_mode_mismatch' });
    await expect(getSessionEvents(params)).rejects.toMatchObject({ code: 'session_content_mode_mismatch' });
  });
});
