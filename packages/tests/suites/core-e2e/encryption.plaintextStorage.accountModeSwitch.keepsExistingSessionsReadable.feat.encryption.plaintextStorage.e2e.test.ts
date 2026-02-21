import { afterEach, describe, expect, it } from 'vitest';

import { createRunDirs } from '../../src/testkit/runDir';
import { fetchJson } from '../../src/testkit/http';
import { createTestAuth } from '../../src/testkit/auth';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: account encryption mode switching keeps existing sessions readable', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('supports e2ee → plain → e2ee without mutating prior sessions and preserves read access', async () => {
    const testDir = run.testDir('encryption-account-mode-switch');
    server = await startServerLight({
      testDir,
      extraEnv: {
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
        HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: '1',
      },
    });

    const auth = await createTestAuth(server.baseUrl);

    const createE2eeSession = async (tag: string) => {
      const res = await fetchJson<any>(`${server!.baseUrl}/v1/sessions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${auth.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tag,
          // Provide ciphertext-like strings; server stores them as-is.
          metadata: Buffer.from(`cipher-meta-${tag}`, 'utf8').toString('base64'),
          agentState: null,
          dataEncryptionKey: Buffer.from(`data-key-${tag}`, 'utf8').toString('base64'),
        }),
        timeoutMs: 15_000,
      });
      expect(res.status).toBe(200);
      expect(res.data?.session?.encryptionMode).toBe('e2ee');
      const sessionId = res.data?.session?.id;
      expect(typeof sessionId).toBe('string');
      return String(sessionId);
    };

    const createPlainSession = async (tag: string) => {
      const res = await fetchJson<any>(`${server!.baseUrl}/v1/sessions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${auth.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tag,
          metadata: JSON.stringify({ v: 1, tag, path: '/tmp', flavor: 'claude' }),
          agentState: null,
          dataEncryptionKey: null,
        }),
        timeoutMs: 15_000,
      });
      expect(res.status).toBe(200);
      expect(res.data?.session?.encryptionMode).toBe('plain');
      const sessionId = res.data?.session?.id;
      expect(typeof sessionId).toBe('string');
      return String(sessionId);
    };

    const readFirstMessageContentType = async (sessionId: string): Promise<'encrypted' | 'plain'> => {
      const messages = await fetchJson<any>(`${server!.baseUrl}/v1/sessions/${sessionId}/messages?limit=10`, {
        headers: { Authorization: `Bearer ${auth.token}` },
        timeoutMs: 15_000,
      });
      expect(messages.status).toBe(200);
      const first = messages.data?.messages?.[0];
      const t = first?.content?.t;
      if (t !== 'encrypted' && t !== 'plain') {
        throw new Error(`Unexpected message content.t: ${JSON.stringify(t)}`);
      }
      return t;
    };

    const patchAccountMode = async (mode: 'plain' | 'e2ee') => {
      const patch = await fetchJson<any>(`${server!.baseUrl}/v1/account/encryption`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${auth.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ mode }),
        timeoutMs: 15_000,
      });
      expect(patch.status).toBe(200);
      expect(patch.data?.mode).toBe(mode);
    };

    const sessionA = await createE2eeSession('e2e-switch-a');
    const writeA = await fetchJson<any>(`${server.baseUrl}/v2/sessions/${sessionA}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        localId: 'm-a-1',
        ciphertext: Buffer.from('cipher-a-1', 'utf8').toString('base64'),
      }),
      timeoutMs: 15_000,
    });
    expect(writeA.status).toBe(200);
    expect(writeA.data?.didWrite).toBe(true);
    expect(await readFirstMessageContentType(sessionA)).toBe('encrypted');

    await patchAccountMode('plain');
    const sessionB = await createPlainSession('e2e-switch-b');
    const writeB = await fetchJson<any>(`${server.baseUrl}/v2/sessions/${sessionB}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        localId: 'm-b-1',
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'plain-b-1' } } },
      }),
      timeoutMs: 15_000,
    });
    expect(writeB.status).toBe(200);
    expect(writeB.data?.didWrite).toBe(true);
    expect(await readFirstMessageContentType(sessionB)).toBe('plain');

    await patchAccountMode('e2ee');
    // Create a new session without explicitly setting encryptionMode, but still providing encryption materials.
    // This asserts that the account mode influences the server's default selection, while satisfying required fields.
    const createC = await fetchJson<any>(`${server.baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tag: 'e2e-switch-c',
        metadata: Buffer.from('cipher-meta-c', 'utf8').toString('base64'),
        agentState: null,
        dataEncryptionKey: Buffer.from('data-key-c', 'utf8').toString('base64'),
      }),
      timeoutMs: 15_000,
    });
    expect(createC.status).toBe(200);
    expect(createC.data?.session?.encryptionMode).toBe('e2ee');
    const sessionC = String(createC.data?.session?.id);
    expect(sessionC).toMatch(/\S+/);

    const writeC = await fetchJson<any>(`${server.baseUrl}/v2/sessions/${sessionC}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        localId: 'm-c-1',
        ciphertext: Buffer.from('cipher-c-1', 'utf8').toString('base64'),
      }),
      timeoutMs: 15_000,
    });
    expect(writeC.status).toBe(200);
    expect(writeC.data?.didWrite).toBe(true);
    expect(await readFirstMessageContentType(sessionC)).toBe('encrypted');

    // Existing sessions remain accessible and preserve their encryptionMode.
    const sessionARecord = await fetchJson<any>(`${server.baseUrl}/v2/sessions/${sessionA}`, {
      headers: { Authorization: `Bearer ${auth.token}` },
      timeoutMs: 15_000,
    });
    expect(sessionARecord.status).toBe(200);
    expect(sessionARecord.data?.session?.encryptionMode).toBe('e2ee');

    const sessionBRecord = await fetchJson<any>(`${server.baseUrl}/v2/sessions/${sessionB}`, {
      headers: { Authorization: `Bearer ${auth.token}` },
      timeoutMs: 15_000,
    });
    expect(sessionBRecord.status).toBe(200);
    expect(sessionBRecord.data?.session?.encryptionMode).toBe('plain');

    expect(await readFirstMessageContentType(sessionA)).toBe('encrypted');
    expect(await readFirstMessageContentType(sessionB)).toBe('plain');
  }, 180_000);
});
