import { describe, expect, it, vi } from 'vitest';
import { IrohError } from '@happier-dev/iroh-native/node';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { configuration, reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { addServerProfile, adoptServerProfileHomeConnectionDescriptor, getServerProfile, isServerProfileHomeIdentity, removeServerProfile, setServerProfileEndpointsById, useServerProfile } from '@/server/serverProfiles';
import { resolveCliHomeTarget, resolveCurrentCliHomeTarget } from '@/server/homeTarget';
import { createServerFeaturesSnapshotStore } from '@/features/serverFeaturesSnapshotStore';
import { logger } from '@/ui/logger';
import { publishServerHttpRuntimeOrigin, resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

import {
  applyDaemonHomeDescriptorRefresh,
  prepareDaemonHomeIrohTransport,
  readExactProfileHomeMachineRelayUrls,
  resolveCurrentDaemonHomeProfile,
} from './daemonHomeIrohTransport';

const descriptor = {
  v: 1 as const,
  homeServerIdentityId: 'srv_home_daemon',
  canonicalServerUrl: 'https://home.example.test',
  revision: 4,
  endpoints: [{ kind: 'iroh' as const, endpointId: 'c'.repeat(64) }],
};

describe('prepareDaemonHomeIrohTransport', () => {
  it('verifies the current saved route after its captured standard transport becomes stale', async () => {
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL',
      'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
    const cancellation = new AbortController();
    try {
      await withTempDir('happier-daemon-stale-standard-', async homeDir => {
        envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_ACTIVE_SERVER_ID: undefined,
          HAPPIER_SERVER_URL: undefined, HAPPIER_LOCAL_SERVER_URL: undefined,
          HAPPIER_PUBLIC_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined });
        reloadConfiguration();
        const staleRoute = 'http://127.0.0.1:46821';
        const currentRoute = 'http://127.0.0.1:48540';
        const saved = await addServerProfile({ name: 'stale-standard', serverUrl: descriptor.canonicalServerUrl,
          localServerUrl: staleRoute, webappUrl: descriptor.canonicalServerUrl, use: true });
        await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: saved.id, observation: 'exact',
          descriptor: { ...descriptor, endpoints: [{ kind: 'https', url: saved.serverUrl }] } });
        let stale = false;
        // Substitute only HTTP readiness; saved-profile reads and carrier acquisition remain real.
        const transport = await prepareDaemonHomeIrohTransport({ runtime: null,
          profile: await getServerProfile(saved.id), applicationCarrierEligibility: 'standard_only',
          signal: cancellation.signal, probe: async ({ serverUrl }) => {
            if (stale && serverUrl === staleRoute) return { status: 'server_unreachable' };
            return { status: 'ready' };
          } });
        try {
          expect(transport.carrier).toBe('standard');
          stale = true;
          await setServerProfileEndpointsById({ id: saved.id, serverUrl: saved.serverUrl,
            localServerUrl: currentRoute, webappUrl: saved.webappUrl });
          vi.useFakeTimers();
          let readiness: unknown;
          const verification = transport.verifyAuthenticated(crypto.randomUUID()).then(result => { readiness = result; });
          try {
            await vi.waitFor(() => expect(readiness).toEqual({ status: 'ready' }));
            expect(resolveServerHttpBaseUrl()).toBe(currentRoute);
          } finally {
            cancellation.abort();
            await verification;
          }
        } finally {
          vi.useRealTimers();
          await transport.release();
        }
      });
    } finally {
      envScope.restore();
      reloadConfiguration();
    }
  });

  it('uses invocation endpoint overrides for the same saved Home through reconnect without persisting them', async () => {
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL',
      'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
    try {
      await withTempDir('happier-daemon-forward-override-', async homeDir => {
        envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_ACTIVE_SERVER_ID: undefined,
          HAPPIER_SERVER_URL: undefined, HAPPIER_LOCAL_SERVER_URL: undefined,
          HAPPIER_PUBLIC_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined });
        reloadConfiguration();
        const saved = await addServerProfile({ name: 'retained-forward', serverUrl: descriptor.canonicalServerUrl,
          localServerUrl: 'http://127.0.0.1:46821', webappUrl: descriptor.canonicalServerUrl, use: true });
        await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: saved.id, observation: 'exact',
          descriptor: { ...descriptor, endpoints: [{ kind: 'https', url: saved.serverUrl }] } });
        envScope.patch({ HAPPIER_LOCAL_SERVER_URL: 'http://127.0.0.1:48540', HAPPIER_WEBAPP_URL: 'http://127.0.0.1:48540' });
        reloadConfiguration();
        expect(configuration.activeServerId).toBe(saved.id);
        expect(configuration.serverUrl).toBe(saved.serverUrl);
        expect(configuration.apiServerUrl).toBe('http://127.0.0.1:48540');
        expect(configuration.webappUrl).toBe('http://127.0.0.1:48540');
        const { readDaemonStatusSnapshot } = await import('@/daemon/statusSnapshot');
        expect((await readDaemonStatusSnapshot()).server.localServerUrl).toBe(configuration.apiServerUrl);
        const profile = await resolveCurrentDaemonHomeProfile();
        expect(profile.localServerUrl).toBe(configuration.apiServerUrl);
        const transport = await prepareDaemonHomeIrohTransport({ runtime: null, profile,
          applicationCarrierEligibility: 'standard_only', probe: async ({ serverUrl }) => {
            expect(serverUrl).toBe('http://127.0.0.1:48540');
            return { status: 'ready' };
          } });
        try {
          expect(resolveServerHttpBaseUrl()).toBe('http://127.0.0.1:48540');
          await expect(transport.reacquire()).resolves.toEqual({ status: 'ready' });
          expect(resolveServerHttpBaseUrl()).toBe('http://127.0.0.1:48540');
          expect((await getServerProfile(saved.id)).localServerUrl).toBe(saved.localServerUrl);
        } finally {
          await transport.release();
        }
      });
    } finally {
      envScope.restore();
      reloadConfiguration();
    }
  });

  it('reconnects an env scope before exact binding and fails closed after its profile is removed', async () => {
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL',
      'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
    try {
      await withTempDir('happier-daemon-env-reconnect-', async homeDir => {
        envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_ACTIVE_SERVER_ID: 'retained-env-scope',
          HAPPIER_SERVER_URL: descriptor.canonicalServerUrl, HAPPIER_LOCAL_SERVER_URL: undefined,
          HAPPIER_PUBLIC_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined });
        reloadConfiguration();
        const id = configuration.activeServerId;
        await setServerProfileEndpointsById({ id: 'focused-home', serverUrl: 'https://focused.example.test',
          webappUrl: 'https://focused.example.test', use: true });
        const exact = { ...descriptor, endpoints: [{ kind: 'https' as const, url: descriptor.canonicalServerUrl }] };
        let available = false;
        vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ features: {},
          capabilities: { serverIdentity: { serverIdentityId: exact.homeServerIdentityId } },
          ...(available ? { homeConnectionDescriptor: exact } : {}) })));
        const profile = await resolveCurrentDaemonHomeProfile();
        const transport = await prepareDaemonHomeIrohTransport({ runtime: null, profile,
          applicationCarrierEligibility: 'standard_only', probe: async () => ({ status: 'ready' }) });
        try {
          await expect(transport.verifyAuthenticated('fixture-env-token')).resolves.toEqual({ status: 'ready' });
          await expect(transport.reacquire()).resolves.toEqual({ status: 'ready' });
          expect((await getServerProfile(id)).homeConnectionDescriptor).toBeUndefined();
          available = true;
          await expect(transport.reacquire()).resolves.toEqual({ status: 'ready' });
          await expect(transport.verifyAuthenticated('fixture-env-token')).resolves.toEqual({ status: 'ready' });
          expect((await getServerProfile(id)).homeConnectionDescriptor).toEqual(exact);
          expect((await resolveCurrentCliHomeTarget()).homeServerIdentityId).toBe(exact.homeServerIdentityId);
          await expect(transport.reacquire()).resolves.toEqual({ status: 'ready' });
          await removeServerProfile(id);
          await expect(transport.reacquire()).resolves.toMatchObject({ status: 'auth_failed' });
        } finally {
          await transport.release();
        }
      });
    } finally {
      vi.unstubAllGlobals();
      envScope.restore();
      reloadConfiguration();
    }
  });

  it.each([true, false])('binds a fresh daemon through its authenticated tunnel (publication initially available: %s)', async initiallyAvailable => {
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL',
      'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
    try {
      await withTempDir('happier-daemon-fresh-tunnel-', async homeDir => {
        envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_ACTIVE_SERVER_ID: undefined,
          HAPPIER_SERVER_URL: undefined, HAPPIER_LOCAL_SERVER_URL: undefined,
          HAPPIER_PUBLIC_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined });
        reloadConfiguration();
        const serverUrl = 'http://qa.localhost:3020';
        const localServerUrl = 'http://127.0.0.1:57982';
        const profile = await addServerProfile({ name: 'fresh-daemon', serverUrl, localServerUrl, webappUrl: serverUrl });
        const exactDescriptor = { ...descriptor, canonicalServerUrl: serverUrl,
          endpoints: [{ kind: 'https' as const, url: serverUrl }] };
        let publicationAvailable = initiallyAvailable;
        // Only the HTTP boundary is substituted; transport, observation parsing,
        // exact-authority admission and saved-profile persistence remain real.
        vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
          expect(String(url)).toBe(`${localServerUrl}/v1/features/authenticated`);
          expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-terminal-token');
          return Response.json({ features: {},
            capabilities: { serverIdentity: { serverIdentityId: descriptor.homeServerIdentityId } },
            ...(publicationAvailable ? { homeConnectionDescriptor: exactDescriptor } : {}) });
        }));
        const transport = await prepareDaemonHomeIrohTransport({ runtime: null, profile,
          applicationCarrierEligibility: 'standard_only' });
        try {
          await expect(transport.verifyAuthenticated('fixture-terminal-token')).resolves.toEqual({ status: 'ready' });
          if (!initiallyAvailable) {
            expect(await isServerProfileHomeIdentity(profile.id, descriptor.homeServerIdentityId)).toBe(false);
            expect((await getServerProfile(profile.id)).homeConnectionDescriptor).toBeUndefined();
            publicationAvailable = true;
            await expect(transport.verifyAuthenticated('fixture-terminal-token')).resolves.toEqual({ status: 'ready' });
          }
          expect((await getServerProfile(profile.id)).homeConnectionDescriptorAuthority).toBe('exact');
          expect((await getServerProfile(profile.id)).homeConnectionDescriptor).toEqual(exactDescriptor);
          expect(await isServerProfileHomeIdentity(profile.id, descriptor.homeServerIdentityId)).toBe(true);
          expect(await isServerProfileHomeIdentity(profile.id, 'srv_different_home')).toBe(false);
        } finally {
          await transport.release();
        }
      });
    } finally {
      vi.unstubAllGlobals();
      envScope.restore();
      reloadConfiguration();
    }
  });

  it('reports an exact descriptor conflict and recovers on the next valid authenticated refresh', async () => {
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL',
      'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
    const warn = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    try {
      await withTempDir('happier-daemon-descriptor-conflict-', async homeDir => {
        envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_ACTIVE_SERVER_ID: undefined,
          HAPPIER_SERVER_URL: undefined, HAPPIER_LOCAL_SERVER_URL: undefined,
          HAPPIER_PUBLIC_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined });
        reloadConfiguration();
        const profile = await addServerProfile({ name: 'daemon-home', serverUrl: descriptor.canonicalServerUrl,
          webappUrl: descriptor.canonicalServerUrl, use: true });
        await adoptServerProfileHomeConnectionDescriptor({
          expectedProfileId: profile.id, observation: 'exact', descriptor,
        });
        const homeTarget = await resolveCliHomeTarget({ kind: 'saved_profile', profileRef: profile.id });
        const requestReconnect = vi.fn();
        const exactEndpoint = { ...descriptor.endpoints[0]!, directAddresses: ['127.0.0.1:12345'] };
        let published = { ...descriptor, endpoints: [exactEndpoint] };
        const store = createServerFeaturesSnapshotStore({
          fetchSnapshot: async () => ({ status: 'ready', provenance: 'authenticated',
            features: FeaturesResponseSchema.parse({ features: {},
              capabilities: { serverIdentity: { serverIdentityId: descriptor.homeServerIdentityId } },
              homeConnectionDescriptor: published }) }),
          onAuthenticatedReady: async features => {
            await applyDaemonHomeDescriptorRefresh({ features, homeTarget, requestReconnect });
          },
        });

        expect(await store.refresh()).toBeUndefined();
        expect((await getServerProfile(profile.id)).homeConnectionDescriptor).toEqual(descriptor);
        expect(requestReconnect).not.toHaveBeenCalled();
        expect(warn.mock.calls.map(([, diagnostic]) => diagnostic)).toContainEqual(expect.objectContaining({
          status: 'unavailable', code: 'home_descriptor_conflict',
          storedRevision: descriptor.revision, observedRevision: descriptor.revision,
        }));

        published = { ...published, revision: descriptor.revision + 1 };
        expect(await store.refresh()).toMatchObject({ status: 'ready', provenance: 'authenticated' });
        expect((await getServerProfile(profile.id)).homeConnectionDescriptor).toEqual(published);
        expect(requestReconnect).toHaveBeenCalledOnce();
      });
    } finally {
      warn.mockRestore();
      envScope.restore();
      reloadConfiguration();
    }
  });

  it('ignores passive descriptor refresh for an unbound env target without changing the focused profile', async () => {
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL',
      'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
    try {
      await withTempDir('happier-daemon-manual-home-', async (homeDir) => {
        envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_ACTIVE_SERVER_ID: 'manual-daemon',
          HAPPIER_SERVER_URL: descriptor.canonicalServerUrl, HAPPIER_LOCAL_SERVER_URL: undefined,
          HAPPIER_PUBLIC_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined });
        reloadConfiguration();
        const reconnect = vi.fn();
        await setServerProfileEndpointsById({ id: 'focused-home', serverUrl: 'https://focused.example.test',
          webappUrl: 'https://focused.example.test', use: true });
        await expect(applyDaemonHomeDescriptorRefresh({
          features: FeaturesResponseSchema.parse({ features: {},
            capabilities: { serverIdentity: { serverIdentityId: descriptor.homeServerIdentityId } },
            homeConnectionDescriptor: descriptor }),
          requestReconnect: reconnect,
        })).resolves.toBe('ignored');
        expect((await getServerProfile('focused-home')).homeConnectionDescriptor).toBeUndefined();
        await expect(getServerProfile('manual-daemon')).rejects.toThrow('not found');
        expect(reconnect).not.toHaveBeenCalled();
      });
    } finally {
      envScope.restore();
      reloadConfiguration();
    }
  });
  it('keeps descriptor refresh and transport reacquisition on the daemon invocation profile when the focused Home changes', async () => {
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL',
      'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
    try {
      await withTempDir('happier-daemon-profile-scope-', async (homeDir) => {
        const scopedDescriptor = { ...descriptor, endpoints: [{ kind: 'https' as const, url: descriptor.canonicalServerUrl }] };
        envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_ACTIVE_SERVER_ID: undefined,
          HAPPIER_SERVER_URL: undefined, HAPPIER_LOCAL_SERVER_URL: undefined,
          HAPPIER_PUBLIC_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined });
        reloadConfiguration();
        const selected = await addServerProfile({ name: 'daemon-home', serverUrl: descriptor.canonicalServerUrl,
          webappUrl: descriptor.canonicalServerUrl, use: false });
        const focused = await addServerProfile({ name: 'focused-home', serverUrl: 'https://focused.example.test',
          webappUrl: 'https://focused.example.test', use: true });
        envScope.patch({ HAPPIER_ACTIVE_SERVER_ID: selected.id, HAPPIER_SERVER_URL: selected.serverUrl });
        reloadConfiguration();
        expect(configuration.activeServerId).toBe(selected.id);
        const homeTarget = await resolveCurrentCliHomeTarget();
        const reconnect = vi.fn();
        await applyDaemonHomeDescriptorRefresh({
          features: FeaturesResponseSchema.parse({ features: {},
            capabilities: { serverIdentity: { serverIdentityId: descriptor.homeServerIdentityId } },
            homeConnectionDescriptor: scopedDescriptor }),
          requestReconnect: reconnect,
        });
        expect((await getServerProfile(selected.id)).homeConnectionDescriptor).toEqual(scopedDescriptor);
        expect((await getServerProfile(focused.id)).homeConnectionDescriptor).toBeUndefined();
        envScope.patch({ HAPPIER_ACTIVE_SERVER_ID: focused.id, HAPPIER_SERVER_URL: focused.serverUrl });
        reloadConfiguration();
        await expect(applyDaemonHomeDescriptorRefresh({
          homeTarget,
          features: FeaturesResponseSchema.parse({ features: {},
            capabilities: { serverIdentity: { serverIdentityId: descriptor.homeServerIdentityId } },
            homeConnectionDescriptor: scopedDescriptor }),
          requestReconnect: reconnect,
        })).resolves.toBe('unchanged');
        const probedIdentities: string[] = [];
        const transport = await prepareDaemonHomeIrohTransport({
          runtime: null, profile: await getServerProfile(selected.id), token: 'fixture-home-token',
          applicationCarrierEligibility: 'standard_only',
          probe: async input => { probedIdentities.push(input.expectedServerIdentityId); return { status: 'ready' }; },
        });
        expect(resolveServerHttpBaseUrl()).toBe(descriptor.canonicalServerUrl);
        await useServerProfile(focused.id);
        await expect(transport.reacquire()).resolves.toEqual({ status: 'ready' });
        expect(resolveServerHttpBaseUrl()).toBe(descriptor.canonicalServerUrl);
        await transport.release();
        expect(probedIdentities).toEqual([descriptor.homeServerIdentityId, descriptor.homeServerIdentityId]);
      });
    } finally {
      envScope.restore();
      reloadConfiguration();
    }
  });
  it('uses the declared standard endpoint without touching native Iroh under Standard only', async () => {
    const runtime = { ensureHomeTunnel: vi.fn() };
    const probe = vi.fn(async () => ({ status: 'ready' as const }));
    const result = await prepareDaemonHomeIrohTransport({
      runtime: runtime as never,
      profile: {
        serverUrl: descriptor.canonicalServerUrl,
        homeConnectionDescriptor: { ...descriptor, endpoints: [
          { kind: 'https', url: 'https://ingress.example.test' },
          ...descriptor.endpoints,
        ] },
      } as never,
      applicationCarrierEligibility: 'standard_only',
      token: 'home-token',
      probe,
      publishRuntimeOrigin: vi.fn(() => vi.fn()),
    });
    expect(result.carrier).toBe('standard');
    expect(runtime.ensureHomeTunnel).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ serverUrl: 'https://ingress.example.test' }));
  });
  it('publishes the descriptor-declared HTTPS origin when it differs from the canonical audience', async () => {
    const httpsOnlyDescriptor = {
      ...descriptor,
      canonicalServerUrl: 'https://canonical-home.example.test',
      endpoints: [{ kind: 'https' as const, url: 'https://ingress-home.example.test' }],
    };
    const probe = vi.fn(async () => ({ status: 'ready' as const }));
    const publish = vi.fn(() => vi.fn());

    const result = await prepareDaemonHomeIrohTransport({
      runtime: null,
      profile: {
        serverUrl: httpsOnlyDescriptor.canonicalServerUrl,
        homeConnectionDescriptor: httpsOnlyDescriptor,
      } as never,
      token: 'home-token',
      probe,
      publishRuntimeOrigin: publish,
    });

    expect(probe).toHaveBeenCalledWith(expect.objectContaining({
      serverUrl: 'https://ingress-home.example.test',
      expectedServerIdentityId: descriptor.homeServerIdentityId,
    }));
    expect(publish).toHaveBeenCalledWith('https://ingress-home.example.test', 'https', undefined, expect.any(String));
    expect(result.carrier).toBe('standard');
  });

  it('publishes an identity-verified pre-auth lease and authenticates it without reacquiring', async () => {
    const releaseNative = vi.fn(async () => undefined);
    const runtime = {
      available: true as const,
      ensureHomeTunnel: vi.fn(async () => ({
        runtimeOrigin: 'http://127.0.0.1:48123', observedPath: 'direct' as const, release: releaseNative,
      })),
    };
    const publish = vi.fn(() => vi.fn());
    const identityProbe = vi.fn(async () => ({ status: 'ready' as const }));
    const probe = vi.fn(async () => ({ status: 'ready' as const }));

    const result = await prepareDaemonHomeIrohTransport({
      runtime: runtime as never,
      profile: { serverUrl: descriptor.canonicalServerUrl, homeConnectionDescriptor: descriptor } as never,
      token: undefined as never,
      identityProbe,
      probe,
      publishRuntimeOrigin: publish,
    });

    expect(identityProbe).toHaveBeenCalledWith({
      serverUrl: 'http://127.0.0.1:48123',
      expectedServerIdentityId: descriptor.homeServerIdentityId,
    });
    expect(publish).toHaveBeenCalledWith(expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/), 'iroh', expect.objectContaining({ descriptor }), expect.any(String));
    expect(probe).not.toHaveBeenCalled();

    await expect(result.verifyAuthenticated('fresh-token')).resolves.toEqual({ status: 'ready' });
    expect(probe).toHaveBeenCalledWith({
      serverUrl: 'http://127.0.0.1:48123',
      token: 'fresh-token',
      expectedServerIdentityId: descriptor.homeServerIdentityId,
    });
    expect(runtime.ensureHomeTunnel).toHaveBeenCalledOnce();
    await result.release();
  });

  it('publishes only an authenticated and identity-matched Iroh runtime origin', async () => {
    const releaseNative = vi.fn(async () => undefined);
    const runtime = {
      available: true as const,
      ensureHomeTunnel: vi.fn(async () => ({
        runtimeOrigin: 'http://127.0.0.1:48123', observedPath: 'direct' as const, release: releaseNative,
      })),
    };
    const publish = vi.fn(() => vi.fn());
    const probe = vi.fn(async () => ({ status: 'ready' as const }));

    const result = await prepareDaemonHomeIrohTransport({
      runtime: runtime as never,
      profile: {
        serverUrl: descriptor.canonicalServerUrl,
        localServerUrl: 'http://127.0.0.1:50259',
        homeConnectionDescriptor: descriptor,
      },
      token: 'account-token',
      readProfile: async () => ({
        serverUrl: descriptor.canonicalServerUrl,
        homeConnectionDescriptor: descriptor,
      }) as never,
      probe,
      publishRuntimeOrigin: publish,
    });

    expect(probe).toHaveBeenCalledWith({
      serverUrl: 'http://127.0.0.1:48123', token: 'account-token',
      expectedServerIdentityId: 'srv_home_daemon',
    });
    expect(publish).toHaveBeenCalledWith(expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/), 'iroh', expect.objectContaining({ descriptor }), expect.any(String));
    expect(result).toMatchObject({ carrier: 'iroh', observedPath: 'direct' });
    await expect(result.reacquire()).resolves.toEqual({ status: 'ready' });
    expect(runtime.ensureHomeTunnel).toHaveBeenCalledTimes(1);
    expect(releaseNative).not.toHaveBeenCalled();
    await result.release();
    expect(releaseNative).toHaveBeenCalledTimes(1);
  });

  it('fails closed when authenticated verification rejects the Home identity', async () => {
    const release = vi.fn(async () => undefined);
    const runtime = {
      available: true as const,
      ensureHomeTunnel: vi.fn(async () => ({
        runtimeOrigin: 'http://127.0.0.1:48123', observedPath: 'unknown' as const, release,
      })),
    };

    const probedOrigins: string[] = [];
    await expect(prepareDaemonHomeIrohTransport({
      runtime: runtime as never,
      profile: { serverUrl: descriptor.canonicalServerUrl, homeConnectionDescriptor: {
        ...descriptor, endpoints: [...descriptor.endpoints, { kind: 'https', url: 'https://public-home.example.test' }],
      } } as never,
      token: 'account-token',
      probe: async ({ serverUrl }) => {
        probedOrigins.push(serverUrl);
        return { status: 'auth_failed', statusCode: 401, errorMessage: 'denied' };
      },
      publishRuntimeOrigin: vi.fn(),
    })).rejects.toThrow(/verification failed/i);
    expect(release).toHaveBeenCalledTimes(1);
    expect(probedOrigins).toEqual(['http://127.0.0.1:48123']);
  });

  it('keeps an Iroh-only Home waiting through a restart during daemon startup', async () => {
    vi.useFakeTimers();
    const publish = vi.fn(() => vi.fn());
    const ensureHomeTunnel = vi.fn(async () => ({
      runtimeOrigin: 'http://127.0.0.1:48123', observedPath: 'relay' as const, release: vi.fn(async () => undefined),
    }));
    let homeReady = false;
    const preparation = prepareDaemonHomeIrohTransport({
      runtime: { available: true, ensureHomeTunnel } as never,
      profile: { serverUrl: descriptor.canonicalServerUrl, homeConnectionDescriptor: descriptor } as never,
      token: 'account-token',
      probe: async () => homeReady ? { status: 'ready' } : { status: 'server_unreachable', errorMessage: 'Home restarting' },
      publishRuntimeOrigin: publish,
    });
    let settled = false;
    void preparation.finally(() => { settled = true; }).catch(() => undefined);
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(settled).toBe(false);
      homeReady = true;
      await vi.advanceTimersByTimeAsync(60_000);
      const transport = await preparation;
      expect(transport.carrier).toBe('iroh');
      expect(ensureHomeTunnel).toHaveBeenCalledOnce();
      expect(publish).toHaveBeenCalledWith(expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/), 'iroh', expect.anything(), expect.any(String));
      await transport.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it('tries Iroh readiness once then publishes identity-verified declared HTTPS', async () => {
    vi.useFakeTimers();
    const release = vi.fn(async () => undefined);
    const httpsUrl = 'https://public-home.example.test';
    const publish = vi.fn(() => vi.fn());

    const probedOrigins: string[] = [];
    const cancellation = new AbortController();
    const preparation = prepareDaemonHomeIrohTransport({
      signal: cancellation.signal,
      runtime: {
        available: true,
        ensureHomeTunnel: vi.fn(async () => ({
          runtimeOrigin: 'http://127.0.0.1:48123',
          observedPath: 'unknown' as const,
          release,
        })),
      } as never,
      profile: {
        serverUrl: descriptor.canonicalServerUrl,
        homeConnectionDescriptor: {
          ...descriptor,
          endpoints: [...descriptor.endpoints, { kind: 'https' as const, url: httpsUrl }],
        },
      } as never,
      token: 'account-token',
      probe: async ({ serverUrl }) => {
        probedOrigins.push(serverUrl);
        return serverUrl === httpsUrl
          ? { status: 'ready' }
          : { status: 'server_unreachable', errorMessage: 'Iroh readiness failed' };
      },
      publishRuntimeOrigin: publish,
    });
    void preparation.catch(() => undefined);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(probedOrigins).toEqual(['http://127.0.0.1:48123', httpsUrl]);
      const transport = await preparation;
      expect(transport.carrier).toBe('standard');
      expect(publish).toHaveBeenCalledWith(httpsUrl, 'https', undefined, expect.any(String));
      await transport.release();
      expect(release).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(probedOrigins).toEqual(['http://127.0.0.1:48123', httpsUrl]);
    } finally {
      cancellation.abort();
      await preparation.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it('uses declared HTTPS after an initial dial timeout but preserves auth refusals and Iroh-only failures', async () => {
    const descriptorWithHttpsFallback = {
      ...descriptor,
      endpoints: [
        ...descriptor.endpoints,
        { kind: 'https' as const, url: 'https://public-home.example.test' },
      ],
    };
    const runtime = {
      available: true as const,
      ensureHomeTunnel: vi.fn(async () => {
        throw new IrohError('transport_timeout', 'timed out');
      }),
    };
    const probe = vi.fn(async ({ serverUrl }: { serverUrl: string }) => (
      serverUrl === 'https://public-home.example.test'
        ? { status: 'ready' as const }
        : { status: 'server_unreachable' as const, errorMessage: 'offline' }
    ));
    const publish = vi.fn(() => vi.fn());

    const transport = await prepareDaemonHomeIrohTransport({
      runtime: runtime as never,
      profile: {
        serverUrl: descriptor.canonicalServerUrl,
        homeConnectionDescriptor: descriptorWithHttpsFallback,
      } as never,
      token: 'account-token',
      probe: probe as never,
      publishRuntimeOrigin: publish,
    });

    expect(transport.carrier).toBe('standard');
    expect(publish).toHaveBeenCalledWith('https://public-home.example.test', 'https', undefined, expect.any(String));
    expect(probe).toHaveBeenCalledOnce();
    await transport.release();

    runtime.ensureHomeTunnel.mockRejectedValueOnce(new IrohError('relay_auth_failed', 'relay denied'));
    await expect(prepareDaemonHomeIrohTransport({
      runtime: runtime as never,
      profile: { serverUrl: descriptor.canonicalServerUrl, homeConnectionDescriptor: descriptorWithHttpsFallback } as never,
      token: 'account-token',
      readProfile: async () => ({
        serverUrl: descriptor.canonicalServerUrl,
        homeConnectionDescriptor: descriptor,
      }) as never,
      probe: probe as never,
      publishRuntimeOrigin: vi.fn(),
    })).rejects.toMatchObject({ code: 'relay_auth_failed' });

    runtime.ensureHomeTunnel.mockRejectedValueOnce(new IrohError('transport_timeout', 'timed out'));
    await expect(prepareDaemonHomeIrohTransport({
      runtime: runtime as never,
      profile: {
        serverUrl: descriptor.canonicalServerUrl,
        localServerUrl: 'http://127.0.0.1:3005',
        homeConnectionDescriptor: descriptor,
      } as never,
      token: 'account-token',
      probe: probe as never,
      publishRuntimeOrigin: vi.fn(),
    })).rejects.toMatchObject({ code: 'transport_timeout' });
  });

  it('never authenticates canonical or loopback origins when required Iroh is unavailable', async () => {
    const probe = vi.fn(async () => ({ status: 'ready' as const }));

    await expect(prepareDaemonHomeIrohTransport({
      runtime: null,
      profile: {
        serverUrl: descriptor.canonicalServerUrl,
        localServerUrl: 'http://127.0.0.1:3005',
        homeConnectionDescriptor: descriptor,
      } as never,
      token: 'account-token',
      probe,
      publishRuntimeOrigin: vi.fn(),
    })).rejects.toThrow(/Iroh/i);

    expect(probe).not.toHaveBeenCalled();
  });

  it.each([undefined, 'http://127.0.0.1:3005'])('allows unavailable Iroh to use an independently verified HTTPS carrier with local route %s', async localServerUrl => {
    const httpsUrl = 'https://public-home.example.test';
    const expectedOrigin = localServerUrl ?? httpsUrl;
    const descriptorWithHttpsFallback = {
      ...descriptor,
      endpoints: [...descriptor.endpoints, { kind: 'https' as const, url: httpsUrl }],
    };
    const probe = vi.fn(async ({ serverUrl }: { serverUrl: string }) => (
      serverUrl === expectedOrigin
        ? { status: 'ready' as const }
        : { status: 'auth_failed' as const, errorMessage: 'unexpected origin' }
    ));
    const publish = vi.fn(() => vi.fn());

    const transport = await prepareDaemonHomeIrohTransport({
      runtime: null,
      profile: {
        serverUrl: descriptor.canonicalServerUrl,
        localServerUrl,
        homeConnectionDescriptor: descriptorWithHttpsFallback,
      } as never,
      token: 'account-token',
      probe: probe as never,
      publishRuntimeOrigin: publish,
    });

    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({
      serverUrl: expectedOrigin, expectedServerIdentityId: descriptor.homeServerIdentityId,
    }));
    expect(publish).toHaveBeenCalledWith(expectedOrigin, 'https', undefined, expect.any(String));
    expect(transport).toMatchObject({ carrier: 'standard', observedPath: 'unknown' });
    await transport.release();
  });

  it('reports a transport outage as unreachable during reacquisition', async () => {
    const runtime = {
      available: true as const,
      ensureHomeTunnel: vi.fn()
        .mockResolvedValueOnce({
          runtimeOrigin: 'http://127.0.0.1:48123',
          observedPath: 'direct' as const,
          release: vi.fn(async () => undefined),
        })
        .mockRejectedValueOnce(new IrohError('transport_timeout', 'timed out')),
    };
    const probe = vi.fn(async ({ serverUrl }: { serverUrl: string }) => (
      serverUrl === 'http://127.0.0.1:48123'
        ? { status: 'ready' as const }
        : { status: 'server_unreachable' as const, errorMessage: 'offline' }
    ));
    const transport = await prepareDaemonHomeIrohTransport({
      runtime: runtime as never,
      profile: { serverUrl: descriptor.canonicalServerUrl, homeConnectionDescriptor: descriptor } as never,
      token: 'account-token',
      readProfile: async () => ({
        serverUrl: descriptor.canonicalServerUrl,
        homeConnectionDescriptor: { ...descriptor, revision: descriptor.revision + 1 },
      }) as never,
      probe: probe as never,
      publishRuntimeOrigin: vi.fn(() => vi.fn()),
    });

    await expect(transport.reacquire()).resolves.toMatchObject({
      status: 'server_unreachable',
      errorMessage: 'timed out',
    });
  });

  it.each(['unavailable', 'home_unreachable', 'transport_timeout', 'transport_closed', 'transport', 'unknown', 'retry_later'] as const)('recovers the same Home over declared HTTPS after %s', async code => {
    const httpsUrl = 'https://public-home.example.test';
    const descriptorWithHttps = {
      ...descriptor,
      endpoints: [...descriptor.endpoints, { kind: 'https' as const, url: httpsUrl }],
    };
    const runtime = {
      available: true as const,
      ensureHomeTunnel: vi.fn()
        .mockResolvedValueOnce({
          runtimeOrigin: 'http://127.0.0.1:48123',
          observedPath: 'direct' as const,
          release: vi.fn(async () => undefined),
        })
        .mockRejectedValueOnce(new IrohError(code === 'retry_later' ? 'transport_timeout' : code, 'Iroh suspended')),
    };
    let outage = false;
    const probe = vi.fn(async ({ serverUrl }: { serverUrl: string }) => (
      serverUrl === httpsUrl || !outage
        ? { status: 'ready' as const }
        : { status: 'retry_later' as const }
    ));
    const transport = await prepareDaemonHomeIrohTransport({
      runtime: runtime as never,
      profile: { serverUrl: descriptor.canonicalServerUrl, homeConnectionDescriptor: descriptorWithHttps } as never,
      token: 'account-token',
      readProfile: async () => ({
        serverUrl: descriptor.canonicalServerUrl,
        homeConnectionDescriptor: { ...descriptorWithHttps,
          revision: descriptorWithHttps.revision + (code === 'retry_later' ? 0 : 1) },
      }) as never,
      probe: probe as never,
      publishRuntimeOrigin: vi.fn(() => vi.fn()),
    });
    outage = true;
    probe.mockClear();

    await expect(transport.reacquire()).resolves.toEqual({ status: 'ready' });
    expect(probe).toHaveBeenCalledWith({ serverUrl: httpsUrl, token: 'account-token',
      expectedServerIdentityId: descriptor.homeServerIdentityId });
    expect(transport.carrier).toBe('standard');
    await transport.release();
  });

  it('keeps the selected Iroh lease published until a verified replacement is installed', async () => {
    const releaseInitialNative = vi.fn(async () => undefined);
    const releaseReplacementNative = vi.fn(async () => undefined);
    const replacementFailure = new IrohError('transport_timeout', 'replacement unavailable');
    const runtime = {
      available: true as const,
      ensureHomeTunnel: vi.fn()
        .mockResolvedValueOnce({
          runtimeOrigin: 'http://127.0.0.1:48123',
          observedPath: 'direct' as const,
          release: releaseInitialNative,
        })
        .mockRejectedValueOnce(replacementFailure)
        .mockResolvedValueOnce({
          runtimeOrigin: 'http://127.0.0.1:48124',
          observedPath: 'relay' as const,
          release: releaseReplacementNative,
        }),
    };
    const unpublishInitial = vi.fn();
    const unpublishReplacement = vi.fn();
    const publish = vi.fn<typeof publishServerHttpRuntimeOrigin>()
      .mockReturnValueOnce(unpublishInitial)
      .mockReturnValueOnce(unpublishReplacement);
    const transport = await prepareDaemonHomeIrohTransport({
      runtime: runtime as never,
      profile: { serverUrl: descriptor.canonicalServerUrl, homeConnectionDescriptor: descriptor } as never,
      token: 'account-token',
      readProfile: async () => ({
        serverUrl: descriptor.canonicalServerUrl,
        homeConnectionDescriptor: { ...descriptor, revision: descriptor.revision + 1 },
      }) as never,
      probe: async () => ({ status: 'ready' }),
      publishRuntimeOrigin: publish,
    });

    await expect(transport.reacquire()).resolves.toEqual({
      status: 'server_unreachable',
      errorMessage: replacementFailure.message,
    });
    expect(unpublishInitial).not.toHaveBeenCalled();
    expect(releaseInitialNative).not.toHaveBeenCalled();

    await expect(transport.reacquire()).resolves.toEqual({ status: 'ready' });
    expect(publish).toHaveBeenNthCalledWith(2, publish.mock.calls[0]![0], 'iroh', expect.objectContaining({
      descriptor: { ...descriptor, revision: descriptor.revision + 1 },
    }), expect.any(String));
    expect(unpublishInitial).toHaveBeenCalledOnce();
    expect(releaseInitialNative).toHaveBeenCalledOnce();
    expect(publish.mock.invocationCallOrder[1]!).toBeLessThan(unpublishInitial.mock.invocationCallOrder[0]!);

    await transport.release();
    expect(unpublishReplacement).toHaveBeenCalledOnce();
    expect(releaseReplacementNative).toHaveBeenCalledOnce();
  });

  it('does not downgrade a selected Iroh lease when the current profile has no descriptor', async () => {
    const releaseNative = vi.fn(async () => undefined);
    const unpublish = vi.fn();
    const transport = await prepareDaemonHomeIrohTransport({
      runtime: {
        available: true,
        ensureHomeTunnel: vi.fn(async () => ({
          runtimeOrigin: 'http://127.0.0.1:48123',
          observedPath: 'direct' as const,
          release: releaseNative,
        })),
      } as never,
      profile: { serverUrl: descriptor.canonicalServerUrl, homeConnectionDescriptor: descriptor } as never,
      token: 'account-token',
      readProfile: async () => ({ serverUrl: descriptor.canonicalServerUrl }) as never,
      probe: async () => ({ status: 'ready' }),
      publishRuntimeOrigin: vi.fn(() => unpublish),
    });

    await expect(transport.reacquire()).resolves.toMatchObject({
      status: 'server_unreachable',
      errorMessage: expect.stringMatching(/descriptor/i),
    });
    expect(unpublish).not.toHaveBeenCalled();
    expect(releaseNative).not.toHaveBeenCalled();

    await transport.release();
    expect(unpublish).toHaveBeenCalledOnce();
    expect(releaseNative).toHaveBeenCalledOnce();
  });

  it('reacquires with the current canonical profile instead of the startup descriptor', async () => {
    const replacementDescriptor = {
      ...descriptor,
      revision: descriptor.revision + 1,
      endpoints: [{ kind: 'iroh' as const, endpointId: 'd'.repeat(64) }],
    };
    const runtime = {
      available: true as const,
      ensureHomeTunnel: vi.fn(async ({ descriptor: requestedDescriptor }) => ({
        runtimeOrigin: `http://127.0.0.1:${requestedDescriptor.revision === descriptor.revision ? 48123 : 48124}`,
        observedPath: 'direct' as const,
        release: vi.fn(async () => undefined),
      })),
    };
    const readProfile = vi.fn(async () => ({
      serverUrl: descriptor.canonicalServerUrl,
      homeConnectionDescriptor: replacementDescriptor,
    }));
    const transport = await prepareDaemonHomeIrohTransport({
      runtime: runtime as never,
      profile: { serverUrl: descriptor.canonicalServerUrl, homeConnectionDescriptor: descriptor } as never,
      token: 'account-token',
      readProfile: readProfile as never,
      probe: async () => ({ status: 'ready' }),
      publishRuntimeOrigin: vi.fn(() => vi.fn()),
    });

    await expect(transport.reacquire()).resolves.toEqual({ status: 'ready' });
    expect(readProfile).toHaveBeenCalledOnce();
    expect(runtime.ensureHomeTunnel.mock.calls.map(([input]) => input.descriptor)).toEqual([
      descriptor,
      replacementDescriptor,
    ]);
    await transport.release();
  });

  it('recovers a Home restart through stable relay hints without parking on stale direct hints', async () => {
    const originalDescriptor = {
      ...descriptor,
      endpoints: [{
        kind: 'iroh' as const,
        endpointId: descriptor.endpoints[0]!.endpointId,
        directAddresses: ['127.0.0.1:40123'],
        relayUrls: ['https://relay.example.test'],
      }],
    };
    const refreshedDescriptor = {
      ...originalDescriptor,
      revision: originalDescriptor.revision + 1,
      endpoints: [{ ...originalDescriptor.endpoints[0]!, directAddresses: ['127.0.0.1:40124'] }],
    };
    let currentDescriptor = originalDescriptor;
    let attempts = 0;
    let oldLeaseUnavailable = false;
    let markHomeReady!: () => void;
    const homeReady = new Promise<void>((resolve) => { markHomeReady = resolve; });
    const runtime = {
      available: true as const,
      endpoint: { endpointId: 'a'.repeat(64), relayUrls: ['https://relay.example.test'] },
      ensureHomeTunnel: vi.fn(async ({ descriptor: requested, relayOnly }: {
        descriptor: typeof originalDescriptor;
        relayOnly?: boolean;
      }) => {
        attempts += 1;
        const directAddresses = requested.endpoints[0]?.directAddresses;
        if (attempts > 1 && !relayOnly && directAddresses?.includes('127.0.0.1:40123')) {
          // The native dial begun during Home downtime cannot finish against
          // the prior process's direct address, even after Home is online.
          await new Promise<void>(() => undefined);
        }
        if (attempts > 1 && relayOnly) await homeReady;
        return {
          runtimeOrigin: `http://127.0.0.1:${48122 + attempts}`,
          observedPath: relayOnly ? 'relay' as const : 'direct' as const,
          release: vi.fn(async () => undefined),
        };
      }),
    };
    const transport = await prepareDaemonHomeIrohTransport({
      runtime: runtime as never,
      profile: { serverUrl: descriptor.canonicalServerUrl, homeConnectionDescriptor: originalDescriptor } as never,
      token: 'account-token',
      readProfile: async () => ({
        serverUrl: descriptor.canonicalServerUrl,
        homeConnectionDescriptor: currentDescriptor,
      }) as never,
      probe: async ({ serverUrl }) => oldLeaseUnavailable && serverUrl === 'http://127.0.0.1:48123'
        ? { status: 'server_unreachable' }
        : { status: 'ready' },
      publishRuntimeOrigin: vi.fn(() => vi.fn()),
    });

    expect(transport.observedPath).toBe('direct');
    oldLeaseUnavailable = true;
    const reacquire = transport.reacquire();
    await vi.waitFor(() => expect(runtime.ensureHomeTunnel).toHaveBeenCalledTimes(2));
    markHomeReady();
    await expect(reacquire).resolves.toEqual({ status: 'ready' });
    expect(transport.observedPath).toBe('relay');
    expect(runtime.ensureHomeTunnel.mock.calls[1]?.[0]).toEqual({
      descriptor: originalDescriptor,
      relayOnly: true,
    });

    currentDescriptor = refreshedDescriptor;
    await expect(transport.reacquire()).resolves.toEqual({ status: 'ready' });
    expect(transport.observedPath).toBe('direct');
    expect(runtime.ensureHomeTunnel.mock.calls[2]?.[0]).toEqual({ descriptor: refreshedDescriptor });
    await transport.release();
  });

  it('keeps a verified direct Iroh lease after a transient Machine socket disconnect', async () => {
    const directAndRelayDescriptor = {
      ...descriptor,
      endpoints: [{
        ...descriptor.endpoints[0]!,
        directAddresses: ['127.0.0.1:40123'],
        relayUrls: ['https://relay.example.test'],
      }],
    };
    const runtime = {
      available: true as const,
      endpoint: { endpointId: 'a'.repeat(64), relayUrls: ['https://relay.example.test'] },
      ensureHomeTunnel: vi.fn(async () => ({
        runtimeOrigin: 'http://127.0.0.1:48123',
        observedPath: 'direct' as const,
        release: vi.fn(async () => undefined),
      })),
    };
    const transport = await prepareDaemonHomeIrohTransport({
      runtime: runtime as never,
      profile: { serverUrl: descriptor.canonicalServerUrl, homeConnectionDescriptor: directAndRelayDescriptor } as never,
      token: 'account-token',
      readProfile: async () => ({
        serverUrl: descriptor.canonicalServerUrl,
        homeConnectionDescriptor: directAndRelayDescriptor,
      }) as never,
      probe: async () => ({ status: 'ready' }),
      publishRuntimeOrigin: vi.fn(() => vi.fn()),
    });

    await expect(transport.reacquire()).resolves.toEqual({ status: 'ready' });
    expect(transport.observedPath).toBe('direct');
    expect(runtime.ensureHomeTunnel).toHaveBeenCalledOnce();
    await transport.release();
  });

  it('does not request relay-only recovery when the daemon endpoint disables relays', async () => {
    const directAndRelayDescriptor = {
      ...descriptor,
      endpoints: [{
        ...descriptor.endpoints[0]!,
        directAddresses: ['127.0.0.1:40123'],
        relayUrls: ['https://relay.example.test'],
      }],
    };
    let oldLeaseUnavailable = false;
    const runtime = {
      available: true as const,
      endpoint: { endpointId: 'a'.repeat(64), relayUrls: [] },
      ensureHomeTunnel: vi.fn(async () => ({
        runtimeOrigin: 'http://127.0.0.1:48123',
        observedPath: 'direct' as const,
        release: vi.fn(async () => undefined),
      })),
    };
    const transport = await prepareDaemonHomeIrohTransport({
      runtime: runtime as never,
      profile: { serverUrl: descriptor.canonicalServerUrl, homeConnectionDescriptor: directAndRelayDescriptor } as never,
      token: 'account-token',
      readProfile: async () => ({
        serverUrl: descriptor.canonicalServerUrl,
        homeConnectionDescriptor: directAndRelayDescriptor,
      }) as never,
      probe: async () => oldLeaseUnavailable
        ? { status: 'server_unreachable' }
        : { status: 'ready' },
      identityProbe: async () => ({ status: 'ready' }),
      publishRuntimeOrigin: vi.fn(() => vi.fn()),
    });

    oldLeaseUnavailable = true;
    await expect(transport.reacquire()).resolves.toMatchObject({ status: 'server_unreachable' });
    expect(runtime.ensureHomeTunnel).toHaveBeenNthCalledWith(2, { descriptor: directAndRelayDescriptor });
    await transport.release();
  });

  it('activates Iroh when the canonical profile learns a descriptor after startup', async () => {
    const runtime = {
      available: true as const,
      ensureHomeTunnel: vi.fn(async () => ({
        runtimeOrigin: 'http://127.0.0.1:48124',
        observedPath: 'relay' as const,
        release: vi.fn(async () => undefined),
      })),
    };
    const transport = await prepareDaemonHomeIrohTransport({
      runtime: runtime as never,
      profile: { serverUrl: descriptor.canonicalServerUrl } as never,
      token: 'account-token',
      readProfile: async () => ({
        serverUrl: descriptor.canonicalServerUrl,
        homeConnectionDescriptor: descriptor,
      }) as never,
      probe: async () => ({ status: 'ready' }),
      publishRuntimeOrigin: vi.fn(() => vi.fn()),
    });

    expect(runtime.ensureHomeTunnel).not.toHaveBeenCalled();
    await expect(transport.reacquire()).resolves.toEqual({ status: 'ready' });
    expect(runtime.ensureHomeTunnel).toHaveBeenCalledWith({ descriptor });
    expect(transport.carrier).toBe('iroh');
    expect(transport.observedPath).toBe('relay');
  });

  it('requests replacement only when feature refresh accepts a newer descriptor', async () => {
    const requestReconnect = vi.fn();
    const reconcileDescriptor = vi.fn()
      .mockResolvedValueOnce({ outcome: 'updated' as const })
      .mockResolvedValueOnce({ outcome: 'unchanged' as const })
      .mockResolvedValueOnce({ outcome: 'stale' as const });
    const features = {
      homeConnectionDescriptor: descriptor,
      capabilities: { serverIdentity: { serverIdentityId: descriptor.homeServerIdentityId } },
    } as never;

    await applyDaemonHomeDescriptorRefresh({ features, reconcileDescriptor, requestReconnect });
    await applyDaemonHomeDescriptorRefresh({ features, reconcileDescriptor, requestReconnect });
    await applyDaemonHomeDescriptorRefresh({ features, reconcileDescriptor, requestReconnect });
    await applyDaemonHomeDescriptorRefresh({
      features: {
        capabilities: { serverIdentity: { serverIdentityId: descriptor.homeServerIdentityId } },
      } as never,
      reconcileDescriptor,
      requestReconnect,
    });

    expect(requestReconnect).toHaveBeenCalledOnce();
    expect(reconcileDescriptor).toHaveBeenCalledTimes(3);
  });

  it('retains a failed predecessor release and retries it during final teardown', async () => {
    let firstReleaseAttempt = true;
    const releaseFirst = vi.fn(async () => {
      if (firstReleaseAttempt) {
        firstReleaseAttempt = false;
        throw new Error('first stop failed');
      }
    });
    const releaseSecond = vi.fn(async () => undefined);
    const runtime = {
      available: true as const,
      ensureHomeTunnel: vi.fn()
        .mockResolvedValueOnce({
          runtimeOrigin: 'http://127.0.0.1:48123', observedPath: 'direct' as const, release: releaseFirst,
        })
        .mockResolvedValueOnce({
          runtimeOrigin: 'http://127.0.0.1:48124', observedPath: 'direct' as const, release: releaseSecond,
        }),
    };
    const transport = await prepareDaemonHomeIrohTransport({
      runtime: runtime as never,
      profile: { serverUrl: descriptor.canonicalServerUrl, homeConnectionDescriptor: descriptor } as never,
      token: 'account-token',
      readProfile: async () => ({
        serverUrl: descriptor.canonicalServerUrl,
        homeConnectionDescriptor: { ...descriptor, revision: descriptor.revision + 1 },
      }) as never,
      probe: async () => ({ status: 'ready' }),
      publishRuntimeOrigin: vi.fn(() => vi.fn()),
    });

    await expect(transport.reacquire()).resolves.toEqual({ status: 'ready' });
    await transport.release();

    expect(releaseFirst).toHaveBeenCalledTimes(2);
    expect(releaseSecond).toHaveBeenCalledTimes(1);
  });

  it('owns and disposes a replacement that completes after terminal release starts', async () => {
    const releaseInitial = vi.fn(async () => undefined);
    const releaseLate = vi.fn(async () => undefined);
    let resolveLate: ((lease: { runtimeOrigin: string; observedPath: 'relay'; release: typeof releaseLate }) => void) | null = null;
    const runtime = {
      available: true as const,
      ensureHomeTunnel: vi.fn()
        .mockResolvedValueOnce({
          runtimeOrigin: 'http://127.0.0.1:48123', observedPath: 'direct' as const, release: releaseInitial,
        })
        .mockImplementationOnce(async () => await new Promise((resolve) => {
          resolveLate = resolve;
        })),
    };
    const unpublishInitial = vi.fn();
    const publish = vi.fn()
      .mockReturnValueOnce(unpublishInitial);
    const transport = await prepareDaemonHomeIrohTransport({
      runtime: runtime as never,
      profile: { serverUrl: descriptor.canonicalServerUrl, homeConnectionDescriptor: descriptor } as never,
      token: 'account-token',
      readProfile: async () => ({
        serverUrl: descriptor.canonicalServerUrl,
        homeConnectionDescriptor: { ...descriptor, revision: descriptor.revision + 1 },
      }) as never,
      probe: async () => ({ status: 'ready' }),
      publishRuntimeOrigin: publish,
    });

    const reacquire = transport.reacquire();
    await vi.waitFor(() => expect(resolveLate).toBeTypeOf('function'));
    const release = transport.release();
    resolveLate!({
      runtimeOrigin: 'http://127.0.0.1:48124',
      observedPath: 'relay',
      release: releaseLate,
    });

    await expect(reacquire).resolves.toMatchObject({ status: 'server_unreachable' });
    await release;
    expect(publish).toHaveBeenCalledTimes(1);
    expect(releaseLate).toHaveBeenCalledTimes(1);
  });

  it('reads Home machineRelayUrls only from exact descriptors and invokes onExactDescriptorAdopted only on non-stale verified refreshes', async () => {
    const relayDescriptor = {
      ...descriptor,
      machineRelayUrls: ['https://relay.example.test'],
    };
    expect(readExactProfileHomeMachineRelayUrls({
      homeConnectionDescriptor: relayDescriptor,
      homeConnectionDescriptorAuthority: 'exact',
    })).toEqual(['https://relay.example.test']);
    expect(readExactProfileHomeMachineRelayUrls({
      homeConnectionDescriptor: relayDescriptor,
      homeConnectionDescriptorAuthority: 'advisory',
    })).toBeUndefined();
    expect(readExactProfileHomeMachineRelayUrls({
      homeConnectionDescriptor: relayDescriptor,
    })).toBeUndefined();
    expect(readExactProfileHomeMachineRelayUrls(null)).toBeUndefined();

    const featuresPayload = FeaturesResponseSchema.parse({
      features: {},
      capabilities: { serverIdentity: { serverIdentityId: descriptor.homeServerIdentityId } },
      homeConnectionDescriptor: relayDescriptor,
    });
    const onExactDescriptorAdopted = vi.fn();
    const requestReconnect = vi.fn();

    await expect(applyDaemonHomeDescriptorRefresh({
      features: featuresPayload,
      reconcileDescriptor: async () => ({ outcome: 'updated' }),
      onExactDescriptorAdopted,
      requestReconnect,
    })).resolves.toBe('updated');
    expect(onExactDescriptorAdopted).toHaveBeenCalledTimes(1);
    expect(onExactDescriptorAdopted).toHaveBeenCalledWith(relayDescriptor);
    expect(requestReconnect).toHaveBeenCalledTimes(1);

    onExactDescriptorAdopted.mockClear();
    requestReconnect.mockClear();
    await expect(applyDaemonHomeDescriptorRefresh({
      features: featuresPayload,
      reconcileDescriptor: async () => ({ outcome: 'unchanged' }),
      onExactDescriptorAdopted,
      requestReconnect,
    })).resolves.toBe('unchanged');
    expect(onExactDescriptorAdopted).toHaveBeenCalledTimes(1);
    expect(requestReconnect).not.toHaveBeenCalled();

    onExactDescriptorAdopted.mockClear();
    await expect(applyDaemonHomeDescriptorRefresh({
      features: featuresPayload,
      reconcileDescriptor: async () => ({ outcome: 'stale' }),
      onExactDescriptorAdopted,
      requestReconnect,
    })).resolves.toBe('stale');
    expect(onExactDescriptorAdopted).not.toHaveBeenCalled();
  });
});
