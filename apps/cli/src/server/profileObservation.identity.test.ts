import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { readSettings, readStoredCredentialsForServerId, updateSettings, writeCredentialsTokenOnlyForServerId } from '@/persistence';
import { deriveServerIdFromUrl } from './serverId';
import { adoptServerProfileHomeConnectionDescriptor, getServerProfile, listServerProfiles, setServerProfileEndpointsById } from './serverProfiles';
import { observeServerProfileHomeConnection } from './profileObservation';
import { prepareDaemonHomeIrohTransport, resolveCurrentDaemonHomeProfile } from '@/daemon/peer/iroh/daemonHomeIrohTransport';

describe('authenticated Home profile identity reuse', () => {
  const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
  afterEach(() => { env.restore(); vi.unstubAllGlobals(); reloadConfiguration(); });

  it.each(['advisory', 'different-home'] as const)('refuses profile reuse for %s observations', async scenario => {
    await withTempDir('happier-profile-identity-refusal-', async homeDir => {
      env.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined, HAPPIER_ACTIVE_SERVER_ID: undefined });
      reloadConfiguration();
      const serverUrl = 'http://fixture.localhost:3012';
      const descriptor = { v: 1 as const, homeServerIdentityId: 'srv_fixture', canonicalServerUrl: serverUrl,
        revision: 1, endpoints: [{ kind: 'https' as const, url: serverUrl }] };
      await setServerProfileEndpointsById({ id: 'owner', serverUrl, webappUrl: serverUrl });
      await setServerProfileEndpointsById({ id: 'selected', serverUrl, webappUrl: serverUrl });
      await adoptServerProfileHomeConnectionDescriptor({ descriptor, expectedProfileId: 'owner', observation: 'exact' });
      if (scenario === 'different-home') await adoptServerProfileHomeConnectionDescriptor({
        descriptor: { ...descriptor, homeServerIdentityId: 'srv_other' }, expectedProfileId: 'selected', observation: 'exact',
      });
      const before = await readSettings();
      await expect(adoptServerProfileHomeConnectionDescriptor({ descriptor, expectedProfileId: 'selected',
        observation: scenario === 'advisory' ? 'advisory' : 'exact' })).rejects.toMatchObject({ code: 'identity_mismatch' });
      expect(await readSettings()).toEqual(before);
    });
  });

  it.each(['env', 'stack'] as const)('starts a seeded daemon when the %s profile already owns its Home', async ownerKind => {
    await withTempDir('happier-profile-identity-reuse-', async homeDir => {
      const serverUrl = 'http://fixture.localhost:3012';
      const envId = deriveServerIdFromUrl(serverUrl);
      const stackId = 'stack_fixture__id_account';
      const ownerId = ownerKind === 'env' ? envId : stackId;
      const selectedId = ownerKind === 'env' ? stackId : envId;
      env.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: serverUrl,
        HAPPIER_WEBAPP_URL: serverUrl, HAPPIER_ACTIVE_SERVER_ID: selectedId });
      reloadConfiguration();
      await setServerProfileEndpointsById({ id: ownerId, serverUrl, webappUrl: serverUrl });
      const descriptor = { v: 1 as const, homeServerIdentityId: 'srv_fixture', canonicalServerUrl: serverUrl,
        revision: 1, endpoints: [{ kind: 'https' as const, url: serverUrl }] };
      await adoptServerProfileHomeConnectionDescriptor({ descriptor, expectedProfileId: ownerId, observation: 'exact' });
      const bearer = randomUUID();
      const ownerBearer = randomUUID();
      await writeCredentialsTokenOnlyForServerId(ownerId, { token: ownerBearer });
      await writeCredentialsTokenOnlyForServerId(selectedId, { token: bearer });
      await updateSettings(current => ({ ...current,
        machineIdByServerId: { ...current.machineIdByServerId, [selectedId]: 'selected-machine', [ownerId]: 'owner-machine' },
      }));
      const before = await readSettings();
      const profile = await resolveCurrentDaemonHomeProfile();
      expect(profile.id).toBe(selectedId);
      expect(profile.homeConnectionDescriptor).toBeUndefined();
      const advanced = { ...descriptor, revision: 2 };
      vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ features: {},
        capabilities: { serverIdentity: { serverIdentityId: descriptor.homeServerIdentityId } },
        homeConnectionDescriptor: advanced })));
      const transport = await prepareDaemonHomeIrohTransport({ runtime: null, profile, token: bearer });
      try {
        expect(await transport.verifyAuthenticated(bearer)).toEqual({ status: 'ready' });
      } finally { await transport.release(); }
      const observation = await observeServerProfileHomeConnection({ profileId: selectedId, serverUrl, token: bearer });
      expect(observation.profile.id).toBe(ownerId);
      expect((await getServerProfile(ownerId)).homeConnectionDescriptor).toEqual(advanced);
      expect((await listServerProfiles()).filter(saved => saved.homeConnectionDescriptor?.homeServerIdentityId === descriptor.homeServerIdentityId)
        .map(saved => saved.id)).toEqual([ownerId]);
      expect((await getServerProfile(selectedId)).homeConnectionDescriptor).toBeUndefined();
      const after = await readSettings();
      expect(after.activeServerId).toBe(before.activeServerId);
      expect(after.machineIdByServerId).toEqual(before.machineIdByServerId);
      expect((await readStoredCredentialsForServerId(selectedId))?.token === bearer).toBe(true);
      expect((await readStoredCredentialsForServerId(ownerId))?.token === ownerBearer).toBe(true);
    });
  });
});
