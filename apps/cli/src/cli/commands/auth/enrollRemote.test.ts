import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { configuration, reloadConfiguration } from '@/configuration';
import { useServerProfile } from '@/server/serverProfiles';
import { prepareRemoteEnrollmentHomeTarget } from './enrollRemote';

describe('prepareRemoteEnrollmentHomeTarget', () => {
  let envScope = createEnvKeyScope([
    'HAPPIER_HOME_DIR',
    'HAPPIER_SERVER_URL',
    'HAPPIER_LOCAL_SERVER_URL',
    'HAPPIER_PUBLIC_SERVER_URL',
    'HAPPIER_WEBAPP_URL',
    'HAPPIER_ACTIVE_SERVER_ID',
  ] as const);

  afterEach(() => {
    envScope.restore();
    reloadConfiguration();
    envScope = createEnvKeyScope([
      'HAPPIER_HOME_DIR',
      'HAPPIER_SERVER_URL',
      'HAPPIER_LOCAL_SERVER_URL',
      'HAPPIER_PUBLIC_SERVER_URL',
      'HAPPIER_WEBAPP_URL',
      'HAPPIER_ACTIVE_SERVER_ID',
    ] as const);
  });

  it('persists the remote public route without inheriting the controller-local route', async () => {
    await withTempDir('happier-cli-remote-enrollment-profile-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_LOCAL_SERVER_URL: undefined,
        HAPPIER_PUBLIC_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
        HAPPIER_ACTIVE_SERVER_ID: undefined,
      });
      reloadConfiguration();
      const prepared = await prepareRemoteEnrollmentHomeTarget({
        kind: 'https_url',
        url: 'https://public-home.example.test',
        localUrl: 'http://127.0.0.1:3010',
        webappUrl: 'https://app.example.test',
      });

      expect(prepared.target).toMatchObject({
        profileId: prepared.profileId,
        canonicalAuthUrl: 'https://public-home.example.test',
        applicationUrl: 'https://public-home.example.test',
        webappUrl: 'https://app.example.test',
      });
      const settings = JSON.parse(await readFile(join(homeDir, 'settings.json'), 'utf8')) as {
        activeServerId?: string;
        servers?: Record<string, { serverUrl?: string; localServerUrl?: string; webappUrl?: string }>;
      };
      expect(settings.activeServerId).not.toBe(prepared.profileId);
      expect(settings.servers?.[prepared.profileId]).toMatchObject({
        serverUrl: 'https://public-home.example.test',
        webappUrl: 'https://app.example.test',
      });
      expect(settings.servers?.[prepared.profileId]?.localServerUrl).toBeUndefined();
    });
  }, 60_000);

  it('keeps the enrolled Home identity while using its declared reachable route after a guest restart', async () => {
    await withTempDir('happier-cli-remote-home-route-', async (homeDir) => {
      const cleanEnvironment = { HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: undefined,
        HAPPIER_LOCAL_SERVER_URL: undefined, HAPPIER_PUBLIC_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined, HAPPIER_ACTIVE_SERVER_ID: undefined };
      envScope.patch(cleanEnvironment);
      reloadConfiguration();
      const canonicalServerUrl = 'http://happier-agent-qa-servers-deploy.localhost:3033';
      const applicationUrl = 'https://home-route.example.test';
      const prepared = await prepareRemoteEnrollmentHomeTarget({ kind: 'descriptor', authority: 'trusted_enrollment',
        descriptor: { v: 1, homeServerIdentityId: 'srv_guest_route', canonicalServerUrl, revision: 1,
          endpoints: [{ kind: 'https', url: canonicalServerUrl }, { kind: 'https', url: applicationUrl }] } });
      await useServerProfile(prepared.profileId);
      // A later command starts with the persisted profile, without enrollment's process-local route.
      envScope.patch(cleanEnvironment);
      reloadConfiguration();
      expect(configuration.activeServerId).toBe(prepared.profileId);
      expect(configuration.serverUrl).toBe(canonicalServerUrl);
      expect(configuration.apiServerUrl).toBe(applicationUrl);
      expect(prepared.target).toMatchObject({ homeServerIdentityId: 'srv_guest_route',
        canonicalAuthUrl: canonicalServerUrl, applicationUrl });
    });
  }, 60_000);
});
