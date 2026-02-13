import { afterEach, describe, expect, it } from 'vitest';

import { createRunDirs } from '../../src/testkit/runDir';
import { fetchJson } from '../../src/testkit/http';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth, type TestAuth } from '../../src/testkit/auth';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: feature negotiation scope and fallback', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('reports social.friends disabled when identity provider is required but unavailable', async () => {
    const testDir = run.testDir('feature-negotiation-friends-provider-fallback');
    server = await startServerLight({
      testDir,
      extraEnv: {
        HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED: '1',
        HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME: '0',
        HAPPIER_FEATURE_SOCIAL_FRIENDS__IDENTITY_PROVIDER: 'github',
      },
    });

    const auth: TestAuth = await createTestAuth(server.baseUrl);

    const features = await fetchJson<any>(`${server.baseUrl}/v1/features`);
    expect(features.status).toBe(200);
    expect(features.data?.features?.social?.friends?.enabled).toBe(false);

    const friends = await fetchJson<any>(`${server.baseUrl}/v1/friends`, {
      headers: {
        Authorization: `Bearer ${auth.token}`,
      },
    });
    expect(friends.status).toBe(200);
    expect(Array.isArray(friends.data?.friends)).toBe(true);
  }, 180_000);

  it('enables social.friends when username mode is allowed without oauth provider config', async () => {
    const testDir = run.testDir('feature-negotiation-friends-username-fallback');
    server = await startServerLight({
      testDir,
      extraEnv: {
        HAPPIER_FEATURE_SOCIAL_FRIENDS__ENABLED: '1',
        HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME: '1',
      },
    });

    const auth: TestAuth = await createTestAuth(server.baseUrl);

    const features = await fetchJson<any>(`${server.baseUrl}/v1/features`);
    expect(features.status).toBe(200);
    expect(features.data?.features?.social?.friends?.enabled).toBe(true);

    const friends = await fetchJson<any>(`${server.baseUrl}/v1/friends`, {
      headers: {
        Authorization: `Bearer ${auth.token}`,
      },
    });
    expect(friends.status).toBe(200);
    expect(Array.isArray(friends.data?.friends)).toBe(true);
  }, 180_000);
});
