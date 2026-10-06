import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveBoxPublicKeyFromSeed } from '@happier-dev/protocol';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { configuration, reloadConfiguration } from '@/configuration';
import { readCredentials, readSettings, updateSettings, writeCredentialsDataKey, writeCredentialsTokenOnlyForServerId } from '@/persistence';
import { deriveServerIdFromName, deriveServerIdFromUrl } from '@/server/serverId';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('server profiles', () => {
  const envKeys = ['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL'] as const;
  let envScope = createEnvKeyScope(envKeys);

  function deriveLegacyEnvServerIdFromUrl(url: string): string {
    const raw = String(url ?? '').trim().replace(/\/+$/, '');
    if (!raw) return 'env_0';
    let h = 2166136261;
    for (let i = 0; i < raw.length; i += 1) {
      h ^= raw.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return `env_${(h >>> 0).toString(16)}`;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    vi.resetModules();
  });

  it.each(['refresh', 'alias', 'other-home', 'stale', 'public', 'unsafe-http'] as const)('reconciles a changed descriptor endpoint through authenticated Home publication: %s', async (scenario) => {
    await withTempDir('happier-cli-profile-port-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_ACTIVE_SERVER_ID: undefined,
        HAPPIER_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined });
      reloadConfiguration();
      const { setServerProfileEndpointsById, adoptServerProfileHomeConnectionDescriptor, getServerProfile } = await import('./serverProfiles');
      const id = 'stack_qa__id_default';
      const oldOrigin = 'http://qa.localhost:3014';
      const newOrigin = 'http://qa.localhost:3012';
      const requestedOrigin = scenario === 'alias' ? 'http://localhost:3012' : newOrigin;
      await setServerProfileEndpointsById({ id, serverUrl: oldOrigin, webappUrl: oldOrigin, use: true });
      const oldDescriptor = { v: 1 as const, homeServerIdentityId: 'srv_port_home', canonicalServerUrl: oldOrigin,
        revision: 1, endpoints: [{ kind: 'https' as const, url: oldOrigin }] };
      await adoptServerProfileHomeConnectionDescriptor({ descriptor: oldDescriptor, expectedProfileId: id, observation: 'exact' });
      await writeCredentialsTokenOnlyForServerId(id, { token: 'fixture-port-token' });
      if (scenario === 'refresh') {
        // Reproduce the live Stack state: its ordinary URLs were already
        // rewritten, but the saved authoritative descriptor still has 3014.
        await updateSettings(settings => ({ ...settings, servers: { ...settings.servers,
          [id]: { ...settings.servers![id], serverUrl: newOrigin,
            localServerUrl: 'http://127.0.0.1:3012', webappUrl: newOrigin },
        } }));
      }
      const published = { ...oldDescriptor, canonicalServerUrl: newOrigin,
        homeServerIdentityId: scenario === 'other-home' ? 'srv_other_home' : oldDescriptor.homeServerIdentityId,
        revision: scenario === 'stale' ? 1 : 2, endpoints: [{ kind: 'https' as const, url: newOrigin }] };
      // Only the network boundary is mocked; schema parsing, credential lookup,
      // identity verification, revision admission and profile persistence are real.
      vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
        if (scenario === 'unsafe-http') throw new Error('Unsafe carrier must not receive a credential');
        if (scenario === 'public' && String(url).endsWith('/authenticated')) return new Response(null, { status: 404 });
        if (scenario === 'public') return Response.json({ features: {}, capabilities: { serverIdentity: { serverIdentityId: published.homeServerIdentityId } }, homeConnectionDescriptor: published });
        expect(String(url)).toBe('http://127.0.0.1:3012/v1/features/authenticated');
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-port-token');
        return Response.json({ features: {}, capabilities: { serverIdentity: { serverIdentityId: published.homeServerIdentityId } },
          homeConnectionDescriptor: published });
      }));
      const update = setServerProfileEndpointsById({ id, serverUrl: requestedOrigin,
        localServerUrl: scenario === 'unsafe-http' ? 'http://unsafe.example.test:3012' : 'http://127.0.0.1:3012', webappUrl: requestedOrigin, use: true });
      if (scenario === 'refresh' || scenario === 'alias') {
        await expect(update).resolves.toMatchObject({ id, serverUrl: requestedOrigin, localServerUrl: 'http://127.0.0.1:3012',
          homeConnectionDescriptor: published, homeConnectionDescriptorAuthority: 'exact' });
        expect((await getServerProfile(id)).homeConnectionDescriptor).toEqual(published);
      } else {
        await expect(update).rejects.toThrow();
        expect(await getServerProfile(id)).toMatchObject({ serverUrl: oldOrigin, homeConnectionDescriptor: oldDescriptor });
        if (scenario === 'unsafe-http') expect(fetch).not.toHaveBeenCalled();
      }
    });
  });

  it('adds a server profile and can switch active server', async () => {
    await withTempDir('happier-cli-servers-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });

      vi.resetModules();
      const {
        addServerProfile,
        getActiveServerProfile,
        useServerProfile,
        listServerProfiles,
      } = await import('./serverProfiles');

      const before = await getActiveServerProfile();
      expect(before.id).toBe('cloud');
      expect(before.name).toBe('Happier Cloud');

      const created = await addServerProfile({
        name: 'selfhost',
        serverUrl: 'https://stack.example.test',
        webappUrl: 'https://app.example.test',
        use: true,
      });
      expect(created.id).toBe('selfhost');

      const active = await getActiveServerProfile();
      expect(active.id).toBe('selfhost');

      await useServerProfile('cloud');
      expect((await getActiveServerProfile()).id).toBe('cloud');

      await useServerProfile('SelfHost');
      expect((await getActiveServerProfile()).id).toBe('selfhost');

      const list = await listServerProfiles();
      expect(list.map((s: { id: string }) => s.id).sort()).toEqual(['cloud', 'selfhost']);
    });
  });

  it('persists the protocol-owned Home descriptor on the active profile without recomposing it', async () => {
    await withTempDir('happier-cli-home-descriptor-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });

      vi.resetModules();
      const {
        addServerProfile,
        getActiveServerProfile,
        reconcileActiveServerProfileHomeConnectionDescriptor,
        setActiveServerProfileHomeConnectionDescriptor,
        setServerProfileEndpointsById,
      } = await import('./serverProfiles');
      const profile = await addServerProfile({
        name: 'personal-home',
        serverUrl: 'http://127.0.0.1:43123',
        webappUrl: 'https://app.example.test',
        use: true,
      });
      const descriptor = {
        v: 1 as const,
        homeServerIdentityId: 'srv_home_cli',
        canonicalServerUrl: 'http://127.0.0.1:43123',
        revision: 7,
        endpoints: [{
          kind: 'iroh' as const,
          endpointId: 'c'.repeat(64),
          relayUrls: ['https://relay.example.test/'],
          directAddresses: ['127.0.0.1:7777'],
        }],
      };

      await setActiveServerProfileHomeConnectionDescriptor(descriptor);
      const firstPersisted = await getActiveServerProfile();
      expect(firstPersisted.homeConnectionDescriptor).toEqual(descriptor);

      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(firstPersisted.updatedAt + 1_000);
      await setActiveServerProfileHomeConnectionDescriptor(descriptor);
      nowSpy.mockRestore();
      expect((await getActiveServerProfile()).updatedAt).toBe(firstPersisted.updatedAt);

      await expect(reconcileActiveServerProfileHomeConnectionDescriptor({
        ...descriptor,
        revision: 8,
        endpoints: [{
          kind: 'iroh',
          endpointId: 'c'.repeat(64),
          relayUrls: ['https://relay-new.example.test/'],
        }],
      })).resolves.toMatchObject({ outcome: 'updated' });
      expect((await getActiveServerProfile()).homeConnectionDescriptor).toEqual({
        ...descriptor,
        revision: 8,
        endpoints: [{
          kind: 'iroh',
          endpointId: 'c'.repeat(64),
          relayUrls: ['https://relay-new.example.test/'],
        }],
      });

      const currentDescriptor = (await getActiveServerProfile()).homeConnectionDescriptor;
      expect(currentDescriptor).toBeDefined();
      await expect(reconcileActiveServerProfileHomeConnectionDescriptor(
        currentDescriptor!,
      )).resolves.toMatchObject({ outcome: 'unchanged' });
      await expect(reconcileActiveServerProfileHomeConnectionDescriptor({
        ...descriptor,
        revision: 7,
      })).resolves.toMatchObject({ outcome: 'stale' });

      await setServerProfileEndpointsById({
        id: profile.id,
        serverUrl: descriptor.canonicalServerUrl,
        webappUrl: 'https://app.example.test',
      });
      expect((await getActiveServerProfile()).homeConnectionDescriptor).toEqual({
        ...descriptor,
        revision: 8,
        endpoints: [{
          kind: 'iroh',
          endpointId: 'c'.repeat(64),
          relayUrls: ['https://relay-new.example.test/'],
        }],
      });
    });
  });

  it('adopts the complete exact route generation without retaining omitted private fields or moving credentials', async () => {
    await withTempDir('happier-cli-home-identity-route-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined });
      vi.resetModules();
      const { addServerProfile, adoptServerProfileHomeConnectionDescriptor, listServerProfiles } = await import('./serverProfiles');
      const original = await addServerProfile({
        name: 'Studio', serverUrl: 'https://old.example.test', webappUrl: 'https://app.example.test', use: true,
      });
      const credentialDir = join(homeDir, 'servers', original.id);
      mkdirSync(credentialDir, { recursive: true });
      await import('node:fs/promises').then(({ writeFile }) => writeFile(join(credentialDir, 'access.key'), 'immutable-owner'));
      const first = {
        v: 1 as const, homeServerIdentityId: 'srv_studio_home', canonicalServerUrl: 'https://old.example.test', revision: 1,
        endpoints: [{ kind: 'iroh' as const, endpointId: 'b'.repeat(64), directAddresses: ['10.0.0.2:7777'] }],
      };
      await adoptServerProfileHomeConnectionDescriptor({ descriptor: first, expectedProfileId: original.id, observation: 'exact' });
      const updated = await adoptServerProfileHomeConnectionDescriptor({
        descriptor: {
          ...first,
          canonicalServerUrl: 'https://new.example.test',
          revision: 2,
          endpoints: [{ kind: 'iroh', endpointId: 'b'.repeat(64), relayUrls: ['https://relay.example.test/'] }],
        },
        observation: 'exact',
      });

      expect(updated.profile).toMatchObject({ id: original.id, serverUrl: 'https://new.example.test' });
      expect(updated.profile.homeConnectionDescriptor?.endpoints).toEqual([{
        kind: 'iroh', endpointId: 'b'.repeat(64), relayUrls: ['https://relay.example.test/'],
      }]);
      expect(await listServerProfiles()).toHaveLength(2);
      expect(await readFile(join(credentialDir, 'access.key'), 'utf8')).toBe('immutable-owner');
    });
  });

  it('keeps established exact routes over advisory Directory updates and promotes the same profile after exact observation', async () => {
    await withTempDir('happier-cli-home-advisory-route-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined });
      vi.resetModules();
      const { adoptServerProfileHomeConnectionDescriptor } = await import('./serverProfiles');
      const exact = {
        v: 1 as const, homeServerIdentityId: 'srv_advisory_home', canonicalServerUrl: 'https://exact.example.test', revision: 1,
        endpoints: [{ kind: 'https' as const, url: 'https://exact.example.test' }],
      };
      const created = await adoptServerProfileHomeConnectionDescriptor({ descriptor: exact, suggestedName: 'Studio', observation: 'exact' });
      const directory = {
        ...exact, canonicalServerUrl: 'https://directory.example.test', revision: 2,
        endpoints: [{ kind: 'https' as const, url: 'https://directory.example.test' }],
      };

      const ignored = await adoptServerProfileHomeConnectionDescriptor({ descriptor: directory, observation: 'advisory' });
      expect(ignored).toMatchObject({ outcome: 'stale', profile: { id: created.profile.id, serverUrl: exact.canonicalServerUrl } });

      const advisoryOnly = await adoptServerProfileHomeConnectionDescriptor({
        descriptor: { ...directory, homeServerIdentityId: 'srv_new_directory_home' },
        suggestedName: 'Directory Home',
        observation: 'advisory',
      });
      expect(advisoryOnly.profile.homeConnectionDescriptorAuthority).toBe('advisory');

      const promoted = await adoptServerProfileHomeConnectionDescriptor({ descriptor: directory, expectedProfileId: created.profile.id, observation: 'exact' });
      expect(promoted.profile).toMatchObject({ id: created.profile.id, serverUrl: directory.canonicalServerUrl, homeConnectionDescriptorAuthority: 'exact' });
    });
  });

  it('keeps URL-equal identity-distinct Homes separate and never copies credentials by URL', async () => {
    await withTempDir('happier-cli-home-url-distinct-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined });
      vi.resetModules();
      const { adoptServerProfileHomeConnectionDescriptor, listServerProfiles } = await import('./serverProfiles');
      const base = { v: 1 as const, canonicalServerUrl: 'https://shared.example.test', revision: 1, endpoints: [{ kind: 'https' as const, url: 'https://shared.example.test' }] };
      const first = await adoptServerProfileHomeConnectionDescriptor({
        descriptor: { ...base, homeServerIdentityId: 'srv_home_alpha' }, suggestedName: 'Alpha', observation: 'exact',
      });
      const firstCredentialDir = join(homeDir, 'servers', first.profile.id);
      mkdirSync(firstCredentialDir, { recursive: true });
      await import('node:fs/promises').then(({ writeFile }) => writeFile(join(firstCredentialDir, 'access.key'), 'alpha-secret'));
      const second = await adoptServerProfileHomeConnectionDescriptor({
        descriptor: { ...base, homeServerIdentityId: 'srv_home_beta' }, suggestedName: 'Beta', observation: 'exact',
      });

      expect(second.profile.id).not.toBe(first.profile.id);
      expect((await listServerProfiles()).filter((profile) => profile.serverUrl === 'https://shared.example.test')).toHaveLength(2);
      expect(existsSync(join(homeDir, 'servers', second.profile.id, 'access.key'))).toBe(false);
      expect(await readFile(join(firstCredentialDir, 'access.key'), 'utf8')).toBe('alpha-secret');
    });
  });

  it('reports duplicate identity as a typed conflict without mutating settings or credentials', async () => {
    await withTempDir('happier-cli-home-identity-conflict-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined });
      vi.resetModules();
      const { addServerProfile, adoptServerProfileHomeConnectionDescriptor, findServerProfileIdentityConflicts } = await import('./serverProfiles');
      const { updateSettings } = await import('@/persistence');
      const one = await addServerProfile({ name: 'One', serverUrl: 'https://one.example.test', webappUrl: 'https://one.example.test' });
      const two = await addServerProfile({ name: 'Two', serverUrl: 'https://two.example.test', webappUrl: 'https://two.example.test' });
      const descriptor = { v: 1 as const, homeServerIdentityId: 'srv_duplicate_home', canonicalServerUrl: 'https://one.example.test', revision: 1, endpoints: [{ kind: 'https' as const, url: 'https://one.example.test' }] };
      await updateSettings((current) => ({ ...current, servers: {
        ...current.servers,
        [one.id]: { ...current.servers![one.id], homeConnectionDescriptor: descriptor },
        [two.id]: { ...current.servers![two.id], homeConnectionDescriptor: { ...descriptor, canonicalServerUrl: 'https://two.example.test', endpoints: [{ kind: 'https', url: 'https://two.example.test' }] } },
      } }));
      const before = await readFile(join(homeDir, 'settings.json'), 'utf8');

      await expect(adoptServerProfileHomeConnectionDescriptor({ descriptor: { ...descriptor, revision: 2 }, observation: 'exact' }))
        .rejects.toMatchObject({ code: 'duplicate_identity', homeServerIdentityId: 'srv_duplicate_home' });
      expect(await readFile(join(homeDir, 'settings.json'), 'utf8')).toBe(before);
      expect(await findServerProfileIdentityConflicts()).toEqual([{ homeServerIdentityId: 'srv_duplicate_home', profileIds: [one.id, two.id] }]);
    });
  });

  it('fails closed on a present-invalid descriptor without URL merge, descriptor erasure, or credential copy', async () => {
    await withTempDir('happier-cli-corrupt-home-descriptor-', async (homeDir) => {
      const serverUrl = 'https://corrupt.example.test';
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });
      vi.resetModules();
      const { updateSettings } = await import('@/persistence');
      const { upsertServerProfileByUrl } = await import('./serverProfiles');
      await updateSettings((current) => ({
        ...current,
        servers: {
          ...current.servers,
          corrupt: {
            id: 'corrupt',
            name: 'Corrupt Home',
            serverUrl,
            webappUrl: serverUrl,
            createdAt: 1,
            updatedAt: 1,
            lastUsedAt: 1,
            homeConnectionDescriptor: {
              v: 1,
              homeServerIdentityId: 'srv_corrupt_home',
              canonicalServerUrl: serverUrl,
              revision: 1,
              endpoints: [{ kind: 'https', url: serverUrl }],
              unknownAuthority: true,
            },
          },
        },
      }));
      const derivedCredentialDir = join(homeDir, 'servers', deriveServerIdFromUrl(serverUrl));
      mkdirSync(derivedCredentialDir, { recursive: true });
      await import('node:fs/promises').then(({ writeFile }) => writeFile(
        join(derivedCredentialDir, 'access.key'),
        'must-not-copy',
      ));
      const settingsPath = join(homeDir, 'settings.json');
      const before = await readFile(settingsPath, 'utf8');

      await expect(upsertServerProfileByUrl({
        name: 'Corrupt Home',
        serverUrl,
        webappUrl: serverUrl,
        use: true,
      })).rejects.toMatchObject({ code: 'invalid_home_descriptor', profileId: 'corrupt' });

      expect(await readFile(settingsPath, 'utf8')).toBe(before);
      expect(existsSync(join(homeDir, 'servers', 'corrupt', 'access.key'))).toBe(false);
    });
  });

  it('refuses to remove the active server profile unless forced', async () => {
    await withTempDir('happier-cli-servers-remove-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });

      vi.resetModules();
      const { addServerProfile, getActiveServerProfile, removeServerProfile } = await import('./serverProfiles');

      await addServerProfile({
        name: 'selfhost',
        serverUrl: 'https://stack.example.test',
        webappUrl: 'https://app.example.test',
        use: true,
      });

      expect((await getActiveServerProfile()).id).toBe('selfhost');

      await expect(removeServerProfile('selfhost')).rejects.toThrow(/active/i);

      const out = await removeServerProfile('selfhost', { force: true });
      expect(out.removed.id).toBe('selfhost');
      expect(out.active.id).toBe('cloud');
    });
  });

  it('can resolve a server profile by name without changing the active server', async () => {
    await withTempDir('happier-cli-servers-resolve-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });

      vi.resetModules();
      const { addServerProfile, getActiveServerProfile, getServerProfile } = await import('./serverProfiles');

      await addServerProfile({
        name: 'selfhost',
        serverUrl: 'https://stack.example.test',
        webappUrl: 'https://app.example.test',
        use: true,
      });

      expect((await getActiveServerProfile()).id).toBe('selfhost');
      expect((await getServerProfile('SelfHost')).id).toBe('selfhost');
      expect((await getActiveServerProfile()).id).toBe('selfhost');
    });
  });

  it('can resolve a server profile by relay URL without changing the active server', async () => {
    await withTempDir('happier-cli-servers-resolve-url-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });

      vi.resetModules();
      const { addServerProfile, getActiveServerProfile, getServerProfile } = await import('./serverProfiles');

      await addServerProfile({
        name: 'remote-dev-tui',
        serverUrl: 'http://127.0.0.1:52753',
        webappUrl: 'http://127.0.0.1:52753',
        use: true,
      });

      expect((await getActiveServerProfile()).id).toBe('remote-dev-tui');
      expect((await getServerProfile('http://127.0.0.1:52753/')).id).toBe('remote-dev-tui');
      expect((await getActiveServerProfile()).id).toBe('remote-dev-tui');
    });
  });

  it('refuses to create a server profile with reserved name "cloud"', async () => {
    await withTempDir('happier-cli-servers-reserved-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });

      vi.resetModules();
      const { addServerProfile } = await import('./serverProfiles');

      await expect(
        addServerProfile({
          name: 'cloud',
          serverUrl: 'https://stack.example.test',
          webappUrl: 'https://app.example.test',
        }),
      ).rejects.toThrow(/reserved/i);
    });
  });

  it('sanitizes profile ids to filesystem-safe values', async () => {
    await withTempDir('happier-cli-servers-sanitize-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });

      vi.resetModules();
      const { addServerProfile } = await import('./serverProfiles');

      const created = await addServerProfile({
        name: '../../escape',
        serverUrl: 'https://stack.example.test',
        webappUrl: 'https://app.example.test',
        use: true,
      });

      expect(created.id).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(created.id.includes('/')).toBe(false);
      expect(created.id.includes('\\')).toBe(false);
      expect(created.id).not.toBe('.');
      expect(created.id).not.toBe('..');
    });
  });

  it('upserts an existing profile when the comparable relay URL already exists', async () => {
    await withTempDir('happier-cli-servers-upsert-url-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });

      vi.resetModules();
      const { addServerProfile, listServerProfiles, upsertServerProfileByUrl } = await import('./serverProfiles');

      const created = await addServerProfile({
        name: 'selfhost',
        serverUrl: 'https://stack.example.test/relay',
        webappUrl: 'https://app.example.test',
        use: false,
      });

      const updated = await upsertServerProfileByUrl({
        name: 'custom',
        serverUrl: 'https://stack.example.test/api',
        localServerUrl: 'http://127.0.0.1:3012',
        webappUrl: 'https://app.example.test',
        use: true,
      });

      expect(updated.id).toBe(created.id);
      expect(updated.localServerUrl).toBe('http://127.0.0.1:3012');
      expect(await listServerProfiles()).toHaveLength(2);
    });
  });

  it('refreshes one named profile endpoint without mutating other profiles or server-scoped settings', async () => {
    await withTempDir('happier-cli-servers-set-endpoints-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });

      vi.resetModules();
      const {
        addServerProfile,
        getActiveServerProfile,
        getServerProfile,
        setServerProfileEndpointsById,
      } = await import('./serverProfiles');
      const { updateSettings } = await import('@/persistence');

      const stackProfile = await addServerProfile({
        name: 'stack-agent-qa',
        serverUrl: 'http://127.0.0.1:3012',
        localServerUrl: 'http://127.0.0.1:3012',
        webappUrl: 'http://localhost:3012',
        use: true,
      });
      const userProfile = await addServerProfile({
        name: 'user-relay',
        serverUrl: 'https://user.example.test',
        webappUrl: 'https://app.user.example.test',
        use: false,
      });
      await updateSettings((current) => {
        const servers = current.servers;
        if (!servers) {
          throw new Error('Expected server profiles to exist after adding test profiles');
        }
        return {
          ...current,
          machineIdByServerId: {
            ...(current.machineIdByServerId ?? {}),
            [stackProfile.id]: 'stack-machine',
            [userProfile.id]: 'user-machine',
          },
          servers: {
            ...servers,
            [stackProfile.id]: { ...servers[stackProfile.id], preservedStackField: 'keep-stack' },
            [userProfile.id]: { ...servers[userProfile.id], preservedUserField: 'keep-user' },
          },
        };
      });

      const updated = await setServerProfileEndpointsById({
        id: stackProfile.id,
        serverUrl: 'http://127.0.0.1:3010',
        localServerUrl: 'http://127.0.0.1:3010',
        webappUrl: 'http://localhost:3010',
        use: true,
      });

      expect(updated).toMatchObject({
        id: stackProfile.id,
        serverUrl: 'http://127.0.0.1:3010',
        webappUrl: 'http://localhost:3010',
      });
      expect((await getActiveServerProfile()).id).toBe(stackProfile.id);
      expect(await getServerProfile(userProfile.id)).toMatchObject({
        id: userProfile.id,
        serverUrl: 'https://user.example.test',
        webappUrl: 'https://app.user.example.test',
      });

      const raw = JSON.parse(await readFile(join(homeDir, 'settings.json'), 'utf-8'));
      expect(raw.servers[stackProfile.id]).toMatchObject({ preservedStackField: 'keep-stack' });
      expect(raw.servers[userProfile.id]).toMatchObject({ preservedUserField: 'keep-user' });
      expect(raw.machineIdByServerId).toEqual({
        [stackProfile.id]: 'stack-machine',
        [userProfile.id]: 'user-machine',
      });
    });
  });

  it('clears a split local URL when the canonical relay URL becomes local again', async () => {
    await withTempDir('happier-cli-servers-upsert-clear-local-url-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });

      vi.resetModules();
      const { addServerProfile, upsertServerProfileByUrl } = await import('./serverProfiles');
      await addServerProfile({
        name: 'selfhost',
        serverUrl: 'https://stack.example.test',
        localServerUrl: 'http://127.0.0.1:3012',
        webappUrl: 'https://stack.example.test',
        use: true,
      });

      const preserved = await upsertServerProfileByUrl({
        name: 'selfhost',
        serverUrl: 'https://stack.example.test',
        webappUrl: 'https://stack.example.test',
        use: true,
      });
      expect(preserved.localServerUrl).toBe('http://127.0.0.1:3012');

      const updated = await upsertServerProfileByUrl({
        name: 'selfhost',
        serverUrl: 'http://127.0.0.1:3012',
        localServerUrl: 'http://127.0.0.1:3012',
        webappUrl: 'http://127.0.0.1:3012',
        use: true,
      });

      expect(updated.serverUrl).toBe('http://127.0.0.1:3012');
      expect(updated.localServerUrl).toBeUndefined();
    });
  });

  it.each([
    { destinationHasState: false, name: 'VM A self-host preview' },
    { destinationHasState: true, name: 'VM A self-host preview' },
    { destinationHasState: false, name: 'constructor' },
  ])('adopts env-derived credentials and state only into an empty named profile ($name, state: $destinationHasState)', async ({ destinationHasState, name }) => {
    await withTempDir('happier-cli-servers-migrate-access-key-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_ACTIVE_SERVER_ID: undefined,
        HAPPIER_SERVER_URL: 'http://127.0.0.1:3005',
        HAPPIER_WEBAPP_URL: 'http://localhost:33005',
      });

      vi.resetModules();
      reloadConfiguration();

      const machineKey = new Uint8Array(32).fill(8);
      await writeCredentialsDataKey({
        token: 'token_super_secret',
        publicKey: deriveBoxPublicKeyFromSeed(machineKey),
        machineKey,
      });
      expect(await readCredentials()).not.toBeNull();
      const envDerivedServerId = configuration.activeServerId;
      expect(envDerivedServerId).toBe(deriveServerIdFromUrl('http://127.0.0.1:3005'));
      expect(existsSync(join(homeDir, 'servers', envDerivedServerId, 'access.key'))).toBe(true);

      const adoptedState = {
        machineIdByServerId: 'machine-adopted',
        machineIdByServerIdByAccountId: { 'account-adopted': 'machine-adopted' },
        lastTokenSubByServerId: 'account-adopted',
        machineIdConfirmedByServerByServerId: true,
        lastChangesCursorByServerIdByAccountId: { 'account-adopted': 42 },
        machineReplacementCandidatesByServerIdByAccountId: { 'account-adopted': { machineId: 'machine-before-adoption', replacementReason: 'reauth', createdAt: 1 } },
      };
      const targetId = deriveServerIdFromName(name);
      await updateSettings((current) => ({
        ...current,
        ...(name === 'constructor' ? { servers: { ...current.servers, [targetId]: { id: targetId, name, serverUrl: 'http://localhost:33005', localServerUrl: 'http://127.0.0.1:3005', webappUrl: 'http://localhost:33005', createdAt: 0, updatedAt: 0, lastUsedAt: 0 } } } : {}),
        machineIdByServerId: { [envDerivedServerId]: adoptedState.machineIdByServerId, ...(destinationHasState ? { [targetId]: 'machine-existing' } : {}) },
        machineIdByServerIdByAccountId: { [envDerivedServerId]: adoptedState.machineIdByServerIdByAccountId },
        lastTokenSubByServerId: { [envDerivedServerId]: adoptedState.lastTokenSubByServerId },
        machineIdConfirmedByServerByServerId: { [envDerivedServerId]: adoptedState.machineIdConfirmedByServerByServerId },
        lastChangesCursorByServerIdByAccountId: { [envDerivedServerId]: adoptedState.lastChangesCursorByServerIdByAccountId },
        machineReplacementCandidatesByServerIdByAccountId: { [envDerivedServerId]: adoptedState.machineReplacementCandidatesByServerIdByAccountId },
      }));

      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_ACTIVE_SERVER_ID: undefined,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });

      vi.resetModules();
      reloadConfiguration();

      const { upsertServerProfileByUrl } = await import('./serverProfiles');

      const created = await upsertServerProfileByUrl({
        name,
        serverUrl: 'http://localhost:33005',
        localServerUrl: 'http://127.0.0.1:3005',
        webappUrl: 'http://localhost:33005',
        use: true,
      });

      expect(created.id).not.toBe(envDerivedServerId);
      expect(created.id).toBe(targetId);
      reloadConfiguration();
      expect(existsSync(join(homeDir, 'servers', created.id, 'access.key'))).toBe(!destinationHasState);
      const settings = await readSettings();
      for (const key of Object.keys(adoptedState) as Array<keyof typeof adoptedState>) {
        expect(settings[key]?.[created.id]).toEqual(destinationHasState
          ? (key === 'machineIdByServerId' ? 'machine-existing' : undefined)
          : adoptedState[key]);
        expect(settings[key]?.[envDerivedServerId]).toEqual(adoptedState[key]);
      }
    });
  });

  it('migrates server-scoped access.key from legacy env-derived serverId when selecting a named profile', async () => {
    await withTempDir('happier-cli-servers-migrate-access-key-legacy-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_ACTIVE_SERVER_ID: undefined,
        HAPPIER_SERVER_URL: 'http://127.0.0.1:3005',
        HAPPIER_WEBAPP_URL: 'http://localhost:33005',
      });

      vi.resetModules();
      reloadConfiguration();

      const machineKey = new Uint8Array(32).fill(8);
      await writeCredentialsDataKey({
        token: 'token_super_secret',
        publicKey: deriveBoxPublicKeyFromSeed(machineKey),
        machineKey,
      });
      expect(await readCredentials()).not.toBeNull();

      const newEnvDerivedServerId = configuration.activeServerId;
      const legacyEnvDerivedServerId = deriveLegacyEnvServerIdFromUrl('http://127.0.0.1:3005');
      expect(newEnvDerivedServerId).not.toBe(legacyEnvDerivedServerId);

      const newKeyPath = join(homeDir, 'servers', newEnvDerivedServerId, 'access.key');
      const legacyKeyPath = join(homeDir, 'servers', legacyEnvDerivedServerId, 'access.key');
      expect(existsSync(newKeyPath)).toBe(true);
      mkdirSync(join(homeDir, 'servers', legacyEnvDerivedServerId), { recursive: true, mode: 0o700 });
      renameSync(newKeyPath, legacyKeyPath);
      expect(existsSync(newKeyPath)).toBe(false);
      expect(existsSync(legacyKeyPath)).toBe(true);

      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_ACTIVE_SERVER_ID: undefined,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });

      vi.resetModules();
      reloadConfiguration();

      const { upsertServerProfileByUrl } = await import('./serverProfiles');
      const created = await upsertServerProfileByUrl({
        name: 'VM A self-host preview',
        serverUrl: 'http://localhost:33005',
        localServerUrl: 'http://127.0.0.1:3005',
        webappUrl: 'http://localhost:33005',
        use: true,
      });

      reloadConfiguration();
      expect(existsSync(join(homeDir, 'servers', created.id, 'access.key'))).toBe(true);
      expect(await readCredentials()).not.toBeNull();
    });
  });

  it('migrates server-scoped access.key when upserting an existing profile that lacks credentials', async () => {
    await withTempDir('happier-cli-servers-migrate-access-key-upsert-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_ACTIVE_SERVER_ID: undefined,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });

      vi.resetModules();
      reloadConfiguration();

      const { addServerProfile, upsertServerProfileByUrl } = await import('./serverProfiles');
      const existing = await addServerProfile({
        name: 'VM A self-host preview',
        serverUrl: 'http://localhost:33005',
        localServerUrl: 'http://127.0.0.1:3005',
        webappUrl: 'http://localhost:33005',
        use: false,
      });

      expect(existsSync(join(homeDir, 'servers', existing.id, 'access.key'))).toBe(false);

      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_ACTIVE_SERVER_ID: undefined,
        HAPPIER_SERVER_URL: 'http://127.0.0.1:3005',
        HAPPIER_WEBAPP_URL: 'http://localhost:33005',
      });

      vi.resetModules();
      reloadConfiguration();

      const machineKey = new Uint8Array(32).fill(8);
      await writeCredentialsDataKey({
        token: 'token_super_secret',
        publicKey: deriveBoxPublicKeyFromSeed(machineKey),
        machineKey,
      });
      expect(await readCredentials()).not.toBeNull();
      const envDerivedServerId = configuration.activeServerId;
      expect(existsSync(join(homeDir, 'servers', envDerivedServerId, 'access.key'))).toBe(true);

      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_ACTIVE_SERVER_ID: undefined,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });

      vi.resetModules();
      reloadConfiguration();

      await upsertServerProfileByUrl({
        name: 'VM A self-host preview',
        serverUrl: 'http://localhost:33005',
        localServerUrl: 'http://127.0.0.1:3005',
        webappUrl: 'http://localhost:33005',
        use: true,
      });

      reloadConfiguration();
      expect(existsSync(join(homeDir, 'servers', existing.id, 'access.key'))).toBe(true);
      expect(await readCredentials()).not.toBeNull();
    });
  });

  it('copies access.key from env-derived serverId when selecting a matching named profile', async () => {
    await withTempDir('happier-cli-servers-migrate-access-key-select-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_ACTIVE_SERVER_ID: undefined,
        HAPPIER_SERVER_URL: 'http://127.0.0.1:3005',
        HAPPIER_WEBAPP_URL: 'http://localhost:33005',
      });

      vi.resetModules();
      reloadConfiguration();

      const machineKey = new Uint8Array(32).fill(8);
      await writeCredentialsDataKey({
        token: 'token_super_secret',
        publicKey: deriveBoxPublicKeyFromSeed(machineKey),
        machineKey,
      });
      const envDerivedServerId = configuration.activeServerId;
      expect(existsSync(join(homeDir, 'servers', envDerivedServerId, 'access.key'))).toBe(true);

      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_ACTIVE_SERVER_ID: undefined,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });

      vi.resetModules();
      reloadConfiguration();

      const { addServerProfile, upsertServerProfileByUrl } = await import('./serverProfiles');
      const named = await addServerProfile({
        name: 'VM A self-host preview',
        serverUrl: 'http://localhost:33005',
        localServerUrl: 'http://127.0.0.1:3005',
        webappUrl: 'http://localhost:33005',
        use: false,
      });

      expect(existsSync(join(homeDir, 'servers', named.id, 'access.key'))).toBe(false);

      await upsertServerProfileByUrl({
        name: 'VM A self-host preview',
        serverUrl: 'http://localhost:33005',
        localServerUrl: 'http://127.0.0.1:3005',
        webappUrl: 'http://localhost:33005',
        use: true,
      });

      reloadConfiguration();
      expect(await readCredentials()).not.toBeNull();
      expect(existsSync(join(homeDir, 'servers', named.id, 'access.key'))).toBe(true);
    });
  });

  it('copies access.key from env-derived serverId when using a named profile by id', async () => {
    await withTempDir('happier-cli-servers-migrate-access-key-use-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_ACTIVE_SERVER_ID: undefined,
        HAPPIER_SERVER_URL: 'http://127.0.0.1:3005',
        HAPPIER_WEBAPP_URL: 'http://localhost:33005',
      });

      vi.resetModules();
      reloadConfiguration();

      const machineKey = new Uint8Array(32).fill(8);
      await writeCredentialsDataKey({
        token: 'token_super_secret',
        publicKey: deriveBoxPublicKeyFromSeed(machineKey),
        machineKey,
      });
      const envDerivedServerId = configuration.activeServerId;
      expect(existsSync(join(homeDir, 'servers', envDerivedServerId, 'access.key'))).toBe(true);

      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_ACTIVE_SERVER_ID: undefined,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
      });

      vi.resetModules();
      reloadConfiguration();

      const { addServerProfile, useServerProfile } = await import('./serverProfiles');
      const named = await addServerProfile({
        name: 'VM A self-host preview',
        serverUrl: 'http://localhost:33005',
        localServerUrl: 'http://127.0.0.1:3005',
        webappUrl: 'http://localhost:33005',
        use: false,
      });

      expect(existsSync(join(homeDir, 'servers', named.id, 'access.key'))).toBe(false);

      await useServerProfile(named.id);

      reloadConfiguration();
      expect(await readCredentials()).not.toBeNull();
      expect(existsSync(join(homeDir, 'servers', named.id, 'access.key'))).toBe(true);
    });
  });
});
