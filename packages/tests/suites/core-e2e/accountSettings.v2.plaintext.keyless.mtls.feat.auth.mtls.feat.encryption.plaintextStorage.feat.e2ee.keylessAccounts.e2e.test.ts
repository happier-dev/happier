import { afterEach, describe, expect, it } from 'vitest';

import { createRunDirs } from '../../src/testkit/runDir';
import { fetchJson } from '../../src/testkit/http';
import { createTestAuthMtls } from '../../src/testkit/auth';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: plaintext keyless accounts require settings v2', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('blocks v1 account settings and roundtrips v2 plaintext settings', async () => {
    const testDir = run.testDir('account-settings-v2-plaintext-keyless-mtls');
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

    const v1 = await fetchJson<any>(`${server.baseUrl}/v1/account/settings`, {
      headers: { Authorization: `Bearer ${auth.token}` },
      timeoutMs: 15_000,
    });
    expect(v1.status).toBe(400);
    expect(v1.data?.error).toBe('plain_account_requires_settings_v2');

    const v2get = await fetchJson<any>(`${server.baseUrl}/v2/account/settings`, {
      headers: { Authorization: `Bearer ${auth.token}` },
      timeoutMs: 15_000,
    });
    expect(v2get.status).toBe(200);
    expect(typeof v2get.data?.version).toBe('number');

    const nextSettings = {
      schemaVersion: 2,
      backendEnabledById: {},
      notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: false },
    };

    const v2post = await fetchJson<any>(`${server.baseUrl}/v2/account/settings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expectedVersion: v2get.data?.version ?? 0,
        content: { t: 'plain', v: nextSettings },
      }),
      timeoutMs: 15_000,
    });
    expect(v2post.status).toBe(200);
    expect(v2post.data?.success).toBe(true);

    const v2get2 = await fetchJson<any>(`${server.baseUrl}/v2/account/settings`, {
      headers: { Authorization: `Bearer ${auth.token}` },
      timeoutMs: 15_000,
    });
    expect(v2get2.status).toBe(200);
    expect(v2get2.data?.content?.t).toBe('plain');
    expect(v2get2.data?.content?.v?.notificationsSettingsV1?.pushEnabled).toBe(true);
  }, 240_000);
});
