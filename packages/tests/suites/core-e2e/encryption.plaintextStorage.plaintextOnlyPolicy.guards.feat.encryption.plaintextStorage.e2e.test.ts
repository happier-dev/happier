import { afterEach, describe, expect, it } from 'vitest';

import { createRunDirs } from '../../src/testkit/runDir';
import { fetchJson } from '../../src/testkit/http';
import { createTestAuth } from '../../src/testkit/auth';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: plaintext_only policy guards', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('rejects e2ee session creation and encrypted writes under plaintext_only, while allowing plaintext writes', async () => {
    const testDir = run.testDir('encryption-plaintext-only-policy-guards');
    server = await startServerLight({
      testDir,
      extraEnv: {
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only',
      },
    });

    const auth = await createTestAuth(server.baseUrl);

    const rejected = await fetchJson<any>(`${server.baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tag: 'e2e-plaintext-only-reject-e2ee',
        encryptionMode: 'e2ee',
        metadata: Buffer.from('cipher-meta', 'utf8').toString('base64'),
        agentState: null,
        dataEncryptionKey: Buffer.from('test-data-key', 'utf8').toString('base64'),
      }),
      timeoutMs: 15_000,
    });
    expect(rejected.status).toBe(400);
    expect(rejected.data?.error).toBe('invalid-params');

    const create = await fetchJson<any>(`${server.baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tag: 'e2e-plaintext-only-session',
        metadata: JSON.stringify({ v: 1, tag: 'e2e-plaintext-only-session' }),
        agentState: null,
        dataEncryptionKey: null,
      }),
      timeoutMs: 15_000,
    });
    expect(create.status).toBe(200);
    const sessionId = create.data?.session?.id;
    expect(typeof sessionId).toBe('string');
    expect(create.data?.session?.encryptionMode).toBe('plain');

    const rejectEncrypted = await fetchJson<any>(`${server.baseUrl}/v2/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        localId: 'm-pt-only-ct-1',
        ciphertext: Buffer.from('nope', 'utf8').toString('base64'),
      }),
      timeoutMs: 15_000,
    });
    expect(rejectEncrypted.status).toBe(400);
    expect(rejectEncrypted.data?.error).toBe('Invalid parameters');

    const localId = 'm-pt-only-plain-1';
    const okPlain = await fetchJson<any>(`${server.baseUrl}/v2/sessions/${sessionId}/messages`, {
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
          v: { role: 'user', content: { type: 'text', text: 'hello plaintext_only' } },
        },
      }),
      timeoutMs: 15_000,
    });
    expect(okPlain.status).toBe(200);
    expect(okPlain.data?.didWrite).toBe(true);

    const messages = await fetchJson<any>(`${server.baseUrl}/v1/sessions/${sessionId}/messages?limit=10`, {
      headers: { Authorization: `Bearer ${auth.token}` },
      timeoutMs: 15_000,
    });
    expect(messages.status).toBe(200);
    const first = messages.data?.messages?.[0];
    expect(first?.content?.t).toBe('plain');
    expect(first?.content?.v?.content?.text).toBe('hello plaintext_only');
  }, 180_000);
});

