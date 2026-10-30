import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import { sendSessionMessage } from './sendSessionMessage';

describe('display-only session notices', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { kind: 'notice' as const, wait: true },
    { kind: 'notice' as const, wait: false, modelOverride: 'model' },
    { kind: 'notice' as const, wait: false, permissionModeOverride: 'yolo' },
    { kind: 'user' as const, wait: false, from: 'hub' },
  ])('rejects incompatible send intent before transport lookup: %j', async (intent) => {
    const get = vi.spyOn(axios, 'get');
    await expect(sendSessionMessage({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      idOrPrefix: 'c000000000000000000000000', message: 'notice', timeoutMs: 1000,
      ...intent,
    })).resolves.toMatchObject({ ok: false, code: 'invalid_arguments' });
    expect(get).not.toHaveBeenCalled();
  });

  it('does not fall back to agent input when the transcript commit fails', async () => {
    const session = createSessionRecordFixture({ id: 'c000000000000000000000000', encryptionMode: 'plain', metadata: '{}' });
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { session } });
    const post = vi.spyOn(axios, 'post').mockRejectedValue(new Error('Relay unavailable'));
    await expect(sendSessionMessage({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      idOrPrefix: session.id, message: 'notice', kind: 'notice', wait: false, timeoutMs: 1000,
    })).rejects.toThrow('Relay unavailable');
    expect(post.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([`/v2/sessions/${session.id}/messages`]);
  });

  it.each([
    { mode: 'plain', active: false },
    { mode: 'e2ee', active: true },
  ] as const)('commits a labelled $mode notice with active=$active without admitting agent input', async ({ mode, active }) => {
    const sessionId = 'c000000000000000000000000';
    const key = new Uint8Array(32).fill(7);
    const session = createSessionRecordFixture({
      id: sessionId,
      active,
      encryptionMode: mode,
      metadata: mode === 'plain' ? '{}' : encodeBase64(encrypt(key, 'legacy', {}), 'base64'),
    });
    // HTTP is the system boundary; lookup, encryption and message admission stay real.
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { session } });
    const writes: Array<{ url: string; body: unknown }> = [];
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      writes.push({ url, body });
      if (!url.endsWith(`/v2/sessions/${sessionId}/messages`)) {
        throw new Error('A display-only notice attempted agent-input admission');
      }
      return {
        status: 200,
        data: { didWrite: true, message: { id: 'message-1', seq: 1, localId: 'notice-1', createdAt: 123 } },
      };
    });
    const input = {
      credentials: { token: 'token', encryption: { type: 'legacy' as const, secret: key } },
      idOrPrefix: sessionId,
      message: 'CI failed\nSee the build log.',
      kind: 'notice' as const,
      from: 'hub',
      localId: 'notice-1',
      wait: false,
      timeoutMs: 1000,
      resumeInactiveSession: false,
    };

    await expect(sendSessionMessage(input)).resolves.toMatchObject({ ok: true, localId: 'notice-1', waited: false });
    expect(writes).toHaveLength(1);
    const body = writes[0]!.body as { content: { t: 'plain'; v: unknown } | { t: 'encrypted'; c: string }; messageRole: string };
    expect(body.messageRole).toBe('event');
    expect(body.content.t).toBe(mode === 'plain' ? 'plain' : 'encrypted');
    const record = body.content.t === 'plain' ? body.content.v : decrypt(key, 'legacy', decodeBase64(body.content.c, 'base64'));
    expect(record).toEqual({
      role: 'agent',
      content: { id: 'notice-1', type: 'event', data: { type: 'message', message: 'hub: CI failed\nSee the build log.' } },
    });

    // An explicit identity must produce the same stored bytes on a retry, including E2EE.
    await sendSessionMessage(input);
    expect(writes[1]).toEqual(writes[0]);
  });
});
