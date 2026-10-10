import { describe, expect, it, vi } from 'vitest';
import { IrohError } from '@happier-dev/iroh-native/node';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { configuration, reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { addServerProfile, getServerProfile, useServerProfile } from '@/server/serverProfiles';
import { resolveCurrentCliHomeTarget } from '@/server/homeTarget';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

import {
  applyDaemonHomeDescriptorRefresh,
  prepareDaemonHomeIrohTransport,
} from './daemonHomeIrohTransport';

const descriptor = {
  v: 1 as const,
  homeServerIdentityId: 'srv_home_daemon',
  canonicalServerUrl: 'https://home.example.test',
  revision: 4,
  endpoints: [{ kind: 'iroh' as const, endpointId: 'c'.repeat(64) }],
};

describe('prepareDaemonHomeIrohTransport', () => {
  it('does not attach an env-only daemon Home descriptor to the focused profile or manufacture a saved profile', async () => {
    const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL',
      'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
    try {
      await withTempDir('happier-daemon-manual-home-', async (homeDir) => {
        envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_ACTIVE_SERVER_ID: 'manual-daemon',
          HAPPIER_SERVER_URL: descriptor.canonicalServerUrl, HAPPIER_LOCAL_SERVER_URL: undefined,
          HAPPIER_PUBLIC_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined });
        reloadConfiguration();
        const reconnect = vi.fn();
        await expect(applyDaemonHomeDescriptorRefresh({
          features: FeaturesResponseSchema.parse({ features: {},
            capabilities: { serverIdentity: { serverIdentityId: descriptor.homeServerIdentityId } },
            homeConnectionDescriptor: descriptor }),
          requestReconnect: reconnect,
        })).resolves.toBe('ignored');
        expect((await getServerProfile('cloud')).homeConnectionDescriptor).toBeUndefined();
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
    expect(publish).toHaveBeenCalledWith('https://ingress-home.example.test', 'https');
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
    expect(publish).toHaveBeenCalledWith('http://127.0.0.1:48123', 'iroh', expect.objectContaining({ descriptor }));
    expect(probe).not.toHaveBeenCalled();

    await expect(result.verifyAuthenticated('fresh-token')).resolves.toEqual({ status: 'ready' });
    expect(probe).toHaveBeenCalledWith({
      serverUrl: 'http://127.0.0.1:48123',
      token: 'fresh-token',
      expectedServerIdentityId: descriptor.homeServerIdentityId,
    });
    expect(runtime.ensureHomeTunnel).toHaveBeenCalledOnce();
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
    expect(publish).toHaveBeenCalledWith('http://127.0.0.1:48123', 'iroh', expect.objectContaining({ descriptor }));
    expect(result).toMatchObject({ carrier: 'iroh', observedPath: 'direct' });
    await expect(result.reacquire()).resolves.toEqual({ status: 'ready' });
    expect(runtime.ensureHomeTunnel).toHaveBeenCalledTimes(2);
    expect(releaseNative).toHaveBeenCalledTimes(1);
    await result.release();
    expect(releaseNative).toHaveBeenCalledTimes(2);
  });

  it('fails closed when authenticated verification rejects the Home identity', async () => {
    const release = vi.fn(async () => undefined);
    const runtime = {
      available: true as const,
      ensureHomeTunnel: vi.fn(async () => ({
        runtimeOrigin: 'http://127.0.0.1:48123', observedPath: 'unknown' as const, release,
      })),
    };

    await expect(prepareDaemonHomeIrohTransport({
      runtime: runtime as never,
      profile: { serverUrl: descriptor.canonicalServerUrl, homeConnectionDescriptor: descriptor } as never,
      token: 'account-token',
      probe: async () => ({ status: 'auth_failed', statusCode: 401, errorMessage: 'denied' }),
      publishRuntimeOrigin: vi.fn(),
    })).rejects.toThrow(/verification failed/i);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('waits on the selected Iroh lease when readiness is unavailable instead of publishing HTTPS', async () => {
    vi.useFakeTimers();
    const release = vi.fn(async () => undefined);
    const httpsUrl = 'https://public-home.example.test';
    const publish = vi.fn(() => vi.fn());

    let reachable = false;
    const preparation = prepareDaemonHomeIrohTransport({
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
      probe: async ({ serverUrl }) => serverUrl === httpsUrl || reachable
        ? { status: 'ready' }
        : { status: 'server_unreachable', errorMessage: 'Iroh readiness failed' },
      publishRuntimeOrigin: publish,
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(release).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      reachable = true;
      await vi.advanceTimersByTimeAsync(250);
      const transport = await preparation;
      expect(transport.carrier).toBe('iroh');
      expect(publish).toHaveBeenCalledWith('http://127.0.0.1:48123', 'iroh', expect.objectContaining({
        descriptor: expect.objectContaining({ homeServerIdentityId: descriptor.homeServerIdentityId }),
      }));
      await transport.release();
      expect(release).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed after selecting Iroh when transport acquisition times out instead of falling back to HTTPS', async () => {
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

    await expect(prepareDaemonHomeIrohTransport({
      runtime: runtime as never,
      profile: {
        serverUrl: descriptor.canonicalServerUrl,
        localServerUrl: 'http://127.0.0.1:3005',
        homeConnectionDescriptor: descriptorWithHttpsFallback,
      } as never,
      token: 'account-token',
      probe: probe as never,
      publishRuntimeOrigin: publish,
    })).rejects.toMatchObject({ code: 'transport_timeout' });

    expect(publish).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();

    runtime.ensureHomeTunnel.mockRejectedValueOnce(new IrohError('relay_auth_failed', 'relay denied'));
    await expect(prepareDaemonHomeIrohTransport({
      runtime: runtime as never,
      profile: { serverUrl: descriptor.canonicalServerUrl, homeConnectionDescriptor: descriptor } as never,
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

  it('allows unavailable Iroh to use only the descriptor-declared independently verified HTTPS origin', async () => {
    const httpsUrl = 'https://public-home.example.test';
    const descriptorWithHttpsFallback = {
      ...descriptor,
      endpoints: [...descriptor.endpoints, { kind: 'https' as const, url: httpsUrl }],
    };
    const probe = vi.fn(async ({ serverUrl }: { serverUrl: string }) => (
      serverUrl === httpsUrl
        ? { status: 'ready' as const }
        : { status: 'auth_failed' as const, errorMessage: 'unexpected origin' }
    ));
    const publish = vi.fn(() => vi.fn());

    const transport = await prepareDaemonHomeIrohTransport({
      runtime: null,
      profile: {
        serverUrl: descriptor.canonicalServerUrl,
        localServerUrl: 'http://127.0.0.1:3005',
        homeConnectionDescriptor: descriptorWithHttpsFallback,
      } as never,
      token: 'account-token',
      probe: probe as never,
      publishRuntimeOrigin: publish,
    });

    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ serverUrl: httpsUrl }));
    expect(publish).toHaveBeenCalledWith(httpsUrl, 'https');
    expect(transport).toMatchObject({ carrier: 'standard', observedPath: 'unknown' });
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
        homeConnectionDescriptor: descriptor,
      }) as never,
      probe: probe as never,
      publishRuntimeOrigin: vi.fn(() => vi.fn()),
    });

    await expect(transport.reacquire()).resolves.toMatchObject({
      status: 'server_unreachable',
      errorMessage: 'timed out',
    });
  });

  it('keeps daemon recovery pinned to a selected Iroh carrier when reacquisition is unavailable', async () => {
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
        .mockRejectedValueOnce(new IrohError('unavailable', 'Iroh suspended')),
    };
    const probe = vi.fn(async ({ serverUrl }: { serverUrl: string }) => (
      serverUrl === httpsUrl
        ? { status: 'ready' as const }
        : { status: 'ready' as const }
    ));
    const transport = await prepareDaemonHomeIrohTransport({
      runtime: runtime as never,
      profile: { serverUrl: descriptor.canonicalServerUrl, homeConnectionDescriptor: descriptorWithHttps } as never,
      token: 'account-token',
      readProfile: async () => ({
        serverUrl: descriptor.canonicalServerUrl,
        homeConnectionDescriptor: descriptorWithHttps,
      }) as never,
      probe: probe as never,
      publishRuntimeOrigin: vi.fn(() => vi.fn()),
    });
    probe.mockClear();

    await expect(transport.reacquire()).resolves.toMatchObject({
      status: 'server_unreachable',
      errorMessage: 'Iroh suspended',
    });
    expect(probe).not.toHaveBeenCalled();
    expect(transport.carrier).toBe('iroh');
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
    const publish = vi.fn()
      .mockReturnValueOnce(unpublishInitial)
      .mockReturnValueOnce(unpublishReplacement);
    const transport = await prepareDaemonHomeIrohTransport({
      runtime: runtime as never,
      profile: { serverUrl: descriptor.canonicalServerUrl, homeConnectionDescriptor: descriptor } as never,
      token: 'account-token',
      readProfile: async () => ({
        serverUrl: descriptor.canonicalServerUrl,
        homeConnectionDescriptor: descriptor,
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
    expect(publish).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:48124', 'iroh', expect.objectContaining({ descriptor }));
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
        homeConnectionDescriptor: descriptor,
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
        homeConnectionDescriptor: descriptor,
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
});
