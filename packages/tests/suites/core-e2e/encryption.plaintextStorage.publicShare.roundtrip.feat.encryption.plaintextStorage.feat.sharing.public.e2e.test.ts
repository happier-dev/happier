import { afterEach, describe, expect, it } from 'vitest';

import { createRunDirs } from '../../src/testkit/runDir';
import { fetchJson } from '../../src/testkit/http';
import { createTestAuth } from '../../src/testkit/auth';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: plaintext public share roundtrip', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('creates a public share without encryptedDataKey for plaintext sessions and reads plain messages', async () => {
    const testDir = run.testDir('encryption-plaintext-public-share-roundtrip');
    server = await startServerLight({
      testDir,
      extraEnv: {
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
        HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: '1',
      },
    });

    const auth = await createTestAuth(server.baseUrl);

    const patchMode = await fetchJson<any>(`${server.baseUrl}/v1/account/encryption`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ mode: 'plain' }),
      timeoutMs: 15_000,
    });
    expect(patchMode.status).toBe(200);
    expect(patchMode.data?.mode).toBe('plain');

    const create = await fetchJson<any>(`${server.baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tag: 'e2e-plaintext-public-share',
        metadata: JSON.stringify({ v: 1, path: '/tmp', flavor: 'claude' }),
        agentState: null,
        dataEncryptionKey: null,
      }),
      timeoutMs: 15_000,
    });
    expect(create.status).toBe(200);
    const sessionId = create.data?.session?.id;
    expect(typeof sessionId).toBe('string');

    const localId = 'm-local-ps-1';
    const commit = await fetchJson<any>(`${server.baseUrl}/v2/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': localId,
      },
      body: JSON.stringify({
        localId,
        content: {
          t: 'plain',
          v: { role: 'user', content: { type: 'text', text: 'hello public' } },
        },
      }),
      timeoutMs: 15_000,
    });
    expect(commit.status).toBe(200);
    expect(commit.data?.didWrite).toBe(true);

    const token = 'tok_plain_share_1';
    const createShare = await fetchJson<any>(`${server.baseUrl}/v1/sessions/${sessionId}/public-share`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token, isConsentRequired: false }),
      timeoutMs: 15_000,
    });
    expect(createShare.status).toBe(200);
    expect(createShare.data?.publicShare?.token).toBe(token);

    const access = await fetchJson<any>(`${server.baseUrl}/v1/public-share/${encodeURIComponent(token)}`, {
      timeoutMs: 15_000,
    });
    expect(access.status).toBe(200);
    expect(access.data?.session?.id).toBe(sessionId);
    expect(access.data?.session?.encryptionMode).toBe('plain');
    expect(access.data?.encryptedDataKey).toBe(null);

    const publicMessages = await fetchJson<any>(`${server.baseUrl}/v1/public-share/${encodeURIComponent(token)}/messages`, {
      timeoutMs: 15_000,
    });
    expect(publicMessages.status).toBe(200);
    const first = publicMessages.data?.messages?.[0];
    expect(first?.content?.t).toBe('plain');
    expect(first?.content?.v?.content?.text).toBe('hello public');
  }, 180_000);
});

