import { afterEach, describe, expect, it } from 'vitest';

import { createRunDirs } from '../../src/testkit/runDir';
import { fetchJson } from '../../src/testkit/http';
import { createTestAuth } from '../../src/testkit/auth';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: legacy account encryption transition keeps existing sessions readable', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('supports compatible e2ee → plain, refuses proofless re-enable, and preserves prior sessions', async () => {
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

    const patchAccountModeToPlain = async () => {
      const patch = await fetchJson<any>(`${server!.baseUrl}/v1/account/encryption`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${auth.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ mode: 'plain' }),
        timeoutMs: 15_000,
      });
      expect(patch.status).toBe(200);
      expect(patch.data?.mode).toBe('plain');
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

    await patchAccountModeToPlain();
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

    const legacyProoflessReenable = await fetchJson<any>(`${server.baseUrl}/v1/account/encryption`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ mode: 'e2ee' }),
      timeoutMs: 15_000,
    });
    expect(legacyProoflessReenable.status).toBe(400);
    expect(legacyProoflessReenable.data).toEqual({ error: 'migration-required' });
    const sessionAfterRejectedReenable = await createPlainSession(
      'e2e-switch-after-rejected-reenable',
    );

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

    const sessionAfterRejectedReenableRecord = await fetchJson<any>(
      `${server.baseUrl}/v2/sessions/${sessionAfterRejectedReenable}`,
      {
        headers: { Authorization: `Bearer ${auth.token}` },
        timeoutMs: 15_000,
      },
    );
    expect(sessionAfterRejectedReenableRecord.status).toBe(200);
    expect(sessionAfterRejectedReenableRecord.data?.session?.encryptionMode).toBe('plain');

    expect(await readFirstMessageContentType(sessionA)).toBe('encrypted');
    expect(await readFirstMessageContentType(sessionB)).toBe('plain');
  }, 180_000);
});
