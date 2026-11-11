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

  it('refuses a different-URL server claiming another saved Home identity without redirecting its credential', async () => {
    await withTempDir('happier-profile-identity-hijack-', async homeDir => {
      env.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined, HAPPIER_ACTIVE_SERVER_ID: undefined });
      reloadConfiguration();
      const ownerUrl = 'https://owner.example.test';
      const selectedUrl = 'https://different-home.example.test';
      const descriptor = { v: 1 as const, homeServerIdentityId: 'srv_fixture', canonicalServerUrl: ownerUrl,
        revision: 1, endpoints: [{ kind: 'https' as const, url: ownerUrl }] };
      await setServerProfileEndpointsById({ id: 'owner', serverUrl: ownerUrl, webappUrl: ownerUrl });
      await setServerProfileEndpointsById({ id: 'selected', serverUrl: selectedUrl, webappUrl: selectedUrl });
      await adoptServerProfileHomeConnectionDescriptor({ descriptor, expectedProfileId: 'owner', observation: 'exact' });
      await writeCredentialsTokenOnlyForServerId('owner', { token: 'fake-owner-token' });
      await writeCredentialsTokenOnlyForServerId('selected', { token: 'fake-selected-token' });
      const before = await readSettings();
      const leakedDestinations: string[] = [];
      vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        const isSelected = url.startsWith(`${selectedUrl}/`);
        if (isSelected && new Headers(init?.headers).get('Authorization') === 'Bearer fake-owner-token') {
          leakedDestinations.push(url);
        }
        return Response.json({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_fixture' } },
          homeConnectionDescriptor: isSelected ? { ...descriptor, revision: 2, canonicalServerUrl: selectedUrl,
            endpoints: [{ kind: 'https', url: selectedUrl }] } : descriptor });
      }));
      const refusal = await observeServerProfileHomeConnection({ profileId: 'selected', serverUrl: selectedUrl,
        token: 'fake-selected-token' }).then(() => null, (error: unknown) => error);
      const owner = await getServerProfile('owner');
      const credential = await readStoredCredentialsForServerId(owner.id);
      await observeServerProfileHomeConnection({ profileId: owner.id,
        serverUrl: owner.localServerUrl ?? owner.serverUrl, token: credential!.token });
      expect(leakedDestinations).toEqual([]);
      expect(refusal).toMatchObject({ code: 'identity_mismatch' });
      expect(await readSettings()).toEqual(before);
      expect(owner.serverUrl).toBe(ownerUrl);
      expect(owner.homeConnectionDescriptor).toEqual(descriptor);
    });
  });

  it.each(['https', 'iroh'] as const)('refuses two-step cross-profile %s endpoint poisoning without disclosing the owner token', async endpointKind => {
    await withTempDir('happier-profile-endpoint-poison-', async homeDir => {
      env.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined, HAPPIER_ACTIVE_SERVER_ID: undefined });
      reloadConfiguration();
      const ownerUrl = 'https://owner.example.test';
      const selectedUrl = 'https://different-home.example.test';
      const descriptor = { v: 1 as const, homeServerIdentityId: 'srv_fixture', canonicalServerUrl: ownerUrl,
        revision: 1, endpoints: [{ kind: 'https' as const, url: ownerUrl }] };
      await setServerProfileEndpointsById({ id: 'owner', serverUrl: ownerUrl, webappUrl: ownerUrl });
      await setServerProfileEndpointsById({ id: 'selected', serverUrl: selectedUrl, webappUrl: selectedUrl });
      await adoptServerProfileHomeConnectionDescriptor({ descriptor, expectedProfileId: 'owner', observation: 'exact' });
      await writeCredentialsTokenOnlyForServerId('owner', { token: 'fake-owner-token' });
      await writeCredentialsTokenOnlyForServerId('selected', { token: 'fake-selected-token' });
      const before = await readSettings();
      const leakedDestinations: string[] = [];
      let step = 0;
      vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        const isSelected = url.startsWith(`${selectedUrl}/`);
        if (isSelected && new Headers(init?.headers).get('Authorization') === 'Bearer fake-owner-token') {
          leakedDestinations.push(url);
        }
        const poisonedEndpoint = endpointKind === 'https'
          ? { kind: 'https' as const, url: selectedUrl }
          : { kind: 'iroh' as const, endpointId: 'b'.repeat(64), relayUrls: ['https://hostile-relay.example.test/'] };
        return Response.json({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_fixture' } },
          homeConnectionDescriptor: isSelected ? { ...descriptor, revision: step + 2,
            canonicalServerUrl: step === 0 ? ownerUrl : selectedUrl,
            endpoints: step === 0 ? [...descriptor.endpoints, poisonedEndpoint] : [poisonedEndpoint] } : descriptor });
      }));
      const firstRefusal = await observeServerProfileHomeConnection({ profileId: 'selected', serverUrl: selectedUrl,
        token: 'fake-selected-token' }).then(() => null, (error: unknown) => error);
      const afterFirst = await readSettings();
      step = 1;
      const secondRefusal = await observeServerProfileHomeConnection({ profileId: 'selected', serverUrl: selectedUrl,
        token: 'fake-selected-token' }).then(() => null, (error: unknown) => error);
      const owner = await getServerProfile('owner');
      const credential = await readStoredCredentialsForServerId(owner.id);
      await observeServerProfileHomeConnection({ profileId: owner.id,
        serverUrl: owner.localServerUrl ?? owner.serverUrl, token: credential!.token });
      expect(firstRefusal).toMatchObject({ code: 'identity_mismatch' });
      expect(secondRefusal).toMatchObject({ code: 'identity_mismatch' });
      expect(afterFirst).toEqual(before);
      expect(await readSettings()).toEqual(before);
      expect(leakedDestinations).toEqual([]);
      expect(owner.homeConnectionDescriptor).toEqual(descriptor);
      expect(owner.serverUrl).toBe(ownerUrl);
    });
  });

  it.each(['omitted', 'known-replacement'] as const)('preserves owner endpoints during %s cross-profile reuse and accepts owner updates', async scenario => {
    await withTempDir('happier-profile-preserve-routes-', async homeDir => {
      env.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined, HAPPIER_ACTIVE_SERVER_ID: undefined });
      reloadConfiguration();
      const ownerUrl = 'https://owner.example.test';
      const knownUrl = 'https://known-route.example.test';
      const descriptor = { v: 1 as const, homeServerIdentityId: 'srv_fixture', canonicalServerUrl: ownerUrl,
        revision: 1, endpoints: [{ kind: 'https' as const, url: ownerUrl },
          { kind: 'iroh' as const, endpointId: 'b'.repeat(64), relayUrls: ['https://relay.example.test/'] }] };
      await setServerProfileEndpointsById({ id: 'owner', serverUrl: ownerUrl, localServerUrl: knownUrl, webappUrl: ownerUrl });
      await setServerProfileEndpointsById({ id: 'selected', serverUrl: knownUrl, webappUrl: knownUrl });
      await adoptServerProfileHomeConnectionDescriptor({ descriptor, expectedProfileId: 'owner', observation: 'exact' });
      const incoming = { ...descriptor, revision: 2,
        endpoints: [{ kind: 'https' as const, url: scenario === 'omitted' ? ownerUrl : knownUrl }] };
      const reused = await adoptServerProfileHomeConnectionDescriptor({ descriptor: incoming,
        expectedProfileId: 'selected', observation: 'exact' });
      expect(reused.profile.homeConnectionDescriptor).toEqual({ ...descriptor, revision: 2 });
      const repeated = await adoptServerProfileHomeConnectionDescriptor({ descriptor: incoming,
        expectedProfileId: 'selected', observation: 'exact' });
      expect(repeated.outcome).toBe('unchanged');
      const ownerUpdate = { ...incoming, revision: 3 };
      const updated = await adoptServerProfileHomeConnectionDescriptor({ descriptor: ownerUpdate,
        expectedProfileId: 'owner', observation: 'exact' });
      expect(updated.profile.homeConnectionDescriptor).toEqual(ownerUpdate);
    });
  });

  it.each(['localServerUrl', 'descriptor'] as const)('allows reuse at a known %s URL', async knownRoute => {
    await withTempDir('happier-profile-known-route-', async homeDir => {
      env.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined, HAPPIER_ACTIVE_SERVER_ID: undefined });
      reloadConfiguration();
      const ownerUrl = 'https://owner.example.test';
      const knownUrl = 'https://known-route.example.test';
      const descriptor = { v: 1 as const, homeServerIdentityId: 'srv_fixture', canonicalServerUrl: ownerUrl,
        revision: 1, endpoints: [{ kind: 'https' as const, url: knownRoute === 'descriptor' ? knownUrl : ownerUrl }] };
      await setServerProfileEndpointsById({ id: 'owner', serverUrl: ownerUrl, webappUrl: ownerUrl,
        ...(knownRoute === 'localServerUrl' ? { localServerUrl: knownUrl } : {}) });
      await setServerProfileEndpointsById({ id: 'selected', serverUrl: knownUrl, webappUrl: knownUrl });
      await adoptServerProfileHomeConnectionDescriptor({ descriptor, expectedProfileId: 'owner', observation: 'exact' });
      const advanced = { ...descriptor, revision: 2, canonicalServerUrl: `${knownUrl}/` };
      const adopted = await adoptServerProfileHomeConnectionDescriptor({ descriptor: advanced,
        expectedProfileId: 'selected', observation: 'exact' });
      expect(adopted.profile.id).toBe('owner');
      expect(adopted.profile.homeConnectionDescriptor).toEqual(advanced);
    });
  });

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
