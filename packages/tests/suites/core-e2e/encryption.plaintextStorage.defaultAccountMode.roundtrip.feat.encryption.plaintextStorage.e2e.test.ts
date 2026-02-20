import { afterEach, describe, expect, it } from 'vitest';

import { createRunDirs } from '../../src/testkit/runDir';
import { fetchJson } from '../../src/testkit/http';
import { createTestAuth } from '../../src/testkit/auth';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: plaintext default account mode', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('defaults new accounts and sessions to plaintext when storagePolicy is optional and defaultAccountMode is plain', async () => {
    const testDir = run.testDir('encryption-plaintext-default-account-mode');
    server = await startServerLight({
      testDir,
      extraEnv: {
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
        HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: '1',
        HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: 'plain',
      },
    });

    const auth = await createTestAuth(server.baseUrl);

    const currentMode = await fetchJson<any>(`${server.baseUrl}/v1/account/encryption`, {
      headers: { Authorization: `Bearer ${auth.token}` },
      timeoutMs: 15_000,
    });
    expect(currentMode.status).toBe(200);
    expect(currentMode.data?.mode).toBe('plain');

    const create = await fetchJson<any>(`${server.baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tag: 'e2e-plaintext-default-account-mode',
        metadata: JSON.stringify({ v: 1, path: '/tmp', flavor: 'claude' }),
        agentState: null,
        dataEncryptionKey: null,
      }),
      timeoutMs: 15_000,
    });
    expect(create.status).toBe(200);
    const sessionId = create.data?.session?.id;
    expect(typeof sessionId).toBe('string');
    expect(create.data?.session?.encryptionMode).toBe('plain');

    const localId = 'm-local-default-plain-1';
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
          v: { role: 'user', content: { type: 'text', text: 'hello default' } },
        },
      }),
      timeoutMs: 15_000,
    });
    expect(commit.status).toBe(200);
    expect(commit.data?.didWrite).toBe(true);

    const messages = await fetchJson<any>(`${server.baseUrl}/v1/sessions/${sessionId}/messages?limit=10`, {
      headers: { Authorization: `Bearer ${auth.token}` },
      timeoutMs: 15_000,
    });
    expect(messages.status).toBe(200);
    const first = messages.data?.messages?.[0];
    expect(first?.content?.t).toBe('plain');
    expect(first?.content?.v?.content?.text).toBe('hello default');
  }, 180_000);
});

