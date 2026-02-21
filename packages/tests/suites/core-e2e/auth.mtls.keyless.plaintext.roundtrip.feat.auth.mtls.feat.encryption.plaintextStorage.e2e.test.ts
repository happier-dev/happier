import { afterEach, describe, expect, it } from 'vitest';

import { createRunDirs } from '../../src/testkit/runDir';
import { fetchJson } from '../../src/testkit/http';
import { createTestAuthMtls } from '../../src/testkit/auth';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: keyless mTLS auth roundtrip (plaintext)', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('auto-provisions a keyless account and can create plaintext sessions', async () => {
    const testDir = run.testDir('auth-mtls-keyless-plaintext-roundtrip');
    server = await startServerLight({
      testDir,
      extraEnv: {
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '0',
        AUTH_ANONYMOUS_SIGNUP_ENABLED: '0',
        AUTH_SIGNUP_PROVIDERS: '',

        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
        HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: 'plain',

        HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: '1',
        HAPPIER_FEATURE_AUTH_MTLS__ENABLED: '1',
        HAPPIER_FEATURE_AUTH_MTLS__MODE: 'forwarded',
        HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION: '1',
        HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: '1',
        HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: 'san_email',
        HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS: 'example.com',
        HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_ISSUERS: 'CN=Example Root CA',
      },
    });

    const auth = await createTestAuthMtls(server.baseUrl, {
      email: 'alice@example.com',
      issuer: 'CN=Example Root CA',
    });

    const mode = await fetchJson<any>(`${server.baseUrl}/v1/account/encryption`, {
      headers: { Authorization: `Bearer ${auth.token}` },
      timeoutMs: 15_000,
    });
    expect(mode.status).toBe(200);
    expect(mode.data?.mode).toBe('plain');

    const create = await fetchJson<any>(`${server.baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tag: 'e2e-mtls-plain',
        metadata: JSON.stringify({ v: 1, flavor: 'claude', tag: 'e2e-mtls-plain' }),
        agentState: null,
        dataEncryptionKey: null,
      }),
      timeoutMs: 15_000,
    });
    expect(create.status).toBe(200);
    const sessionId = create.data?.session?.id;
    expect(typeof sessionId).toBe('string');
    expect(create.data?.session?.encryptionMode).toBe('plain');

    const localId = 'm-mtls-plain-1';
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
          v: { role: 'user', content: { type: 'text', text: 'hello via mtls' } },
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
    expect(first?.content?.v?.content?.text).toBe('hello via mtls');
  }, 240_000);
});

