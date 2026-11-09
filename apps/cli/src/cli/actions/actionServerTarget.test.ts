import { afterEach, expect, it, vi } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import { readStoredCredentials, readStoredCredentialsForServerId, updateSettings, writeCredentialsTokenOnlyForServerId } from '@/persistence';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { admitWidgetActionSurfaceV1 } from '@happier-dev/protocol/widgets';

it.each(['explicit', 'ambient'] as const)('qualifies a URL-only Home from authenticated identity without inventing a connection descriptor (%s)', async selection => {
  await withTempDir('happier-action-withheld-descriptor-', async homeDir => {
    envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_ACTIVE_SERVER_ID: undefined,
      HAPPIER_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined });
    reloadConfiguration();
    const { addServerProfile, getServerProfile, resolveServerProfileHomeIdentityId } = await import('@/server/serverProfiles');
    const { resolveActionCliCredentialTarget } = await import('./actionServerTarget');
    const serverUrl = 'https://withheld-descriptor.example.test';
    const profile = await addServerProfile({ name: 'withheld', serverUrl, webappUrl: serverUrl, use: true });
    await writeCredentialsTokenOnlyForServerId(profile.id, { token: 'fixture-withheld-descriptor-token' });
    let observedIdentity = 'srv_withheld';
    const fetchBoundary = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe(`${serverUrl}/v1/features/authenticated`);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-withheld-descriptor-token');
      return Response.json({ features: {}, capabilities: { serverIdentity: { serverIdentityId: observedIdentity } } });
    });
    vi.stubGlobal('fetch', fetchBoundary);
    const deps = { readCredentialsFn: readStoredCredentials,
      readCredentialsForServerIdFn: readStoredCredentialsForServerId, getServerProfileFn: getServerProfile };
    const requestedServerId = selection === 'explicit' ? profile.id : null;
    const target = await resolveActionCliCredentialTarget({ requestedServerId, requireServerIdentityId: true, deps });
    expect(target.serverIdentityId).toBe(observedIdentity);
    expect(target.fixedServer).toEqual(selection === 'explicit'
      ? { serverId: profile.id, serverIdentityId: observedIdentity, serverApiUrl: serverUrl } : null);
    expect((await getServerProfile(profile.id)).homeConnectionDescriptor).toBeUndefined();
    expect(await resolveServerProfileHomeIdentityId(profile.id)).toBeNull();
    expect(fetchBoundary).toHaveBeenCalledOnce();
    // Identity is scoped to this observation; a later invocation must observe
    // the endpoint again without creating a saved alias or a second read.
    observedIdentity = 'srv_changed';
    const next = await resolveActionCliCredentialTarget({ requestedServerId, requireServerIdentityId: true, deps });
    expect(next.serverIdentityId).toBe(observedIdentity);
    expect(fetchBoundary).toHaveBeenCalledTimes(2);
    expect(await resolveServerProfileHomeIdentityId(profile.id)).toBeNull();
  });
});

const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL']);

it.each(['public', 'missing-identity', 'descriptor-mismatch', 'profile-mismatch'] as const)(
  'refuses an invocation-only Home identity from %s features', async scenario => {
    await withTempDir('happier-action-home-identity-refusal-', async homeDir => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_ACTIVE_SERVER_ID: undefined,
        HAPPIER_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined });
      reloadConfiguration();
      const { addServerProfile, getServerProfile, adoptServerProfileHomeConnectionDescriptor } = await import('@/server/serverProfiles');
      const { resolveActionCliCredentialTarget } = await import('./actionServerTarget');
      const serverUrl = 'https://identity-refusal.example.test';
      const profile = await addServerProfile({ name: 'identity-refusal', serverUrl, webappUrl: serverUrl, use: true });
      if (scenario === 'profile-mismatch') await adoptServerProfileHomeConnectionDescriptor({
        expectedProfileId: profile.id, observation: 'advisory', descriptor: {
          v: 1, homeServerIdentityId: 'srv_original', canonicalServerUrl: serverUrl,
          revision: 1, endpoints: [{ kind: 'https', url: serverUrl }],
        },
      });
      const before = await getServerProfile(profile.id);
      await writeCredentialsTokenOnlyForServerId(profile.id, { token: 'fixture-identity-refusal-token' });
      vi.stubGlobal('fetch', vi.fn<typeof fetch>(async url => {
        if (scenario === 'public' && String(url).endsWith('/authenticated')) return new Response(null, { status: 404 });
        return Response.json({ features: {}, capabilities: { serverIdentity: { serverIdentityId:
          scenario === 'missing-identity' ? null : 'srv_observed' } },
          ...(scenario === 'descriptor-mismatch' ? { homeConnectionDescriptor: {
            v: 1, homeServerIdentityId: 'srv_conflicting', canonicalServerUrl: serverUrl,
            revision: 1, endpoints: [{ kind: 'https', url: serverUrl }],
          } } : {}) });
      }));
      await expect(resolveActionCliCredentialTarget({ requestedServerId: profile.id, requireServerIdentityId: true,
        deps: { readCredentialsFn: readStoredCredentials, readCredentialsForServerIdFn: readStoredCredentialsForServerId,
          getServerProfileFn: getServerProfile } })).rejects.toMatchObject({ code: 'server_identity_unavailable' });
      expect(await getServerProfile(profile.id)).toEqual(before);
    });
  },
);

afterEach(() => {
  vi.unstubAllGlobals();
  envScope.restore();
  vi.resetModules();
});

it('reads the daemon-established Home identity for a separately resolved CLI Action scope', async () => {
  await withTempDir('happier-action-seeded-home-', async homeDir => {
    envScope.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_ACTIVE_SERVER_ID: undefined,
      HAPPIER_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined });
    reloadConfiguration();
    const { addServerProfile, getServerProfile } = await import('@/server/serverProfiles');
    const { prepareDaemonHomeIrohTransport } = await import('@/daemon/peer/iroh/daemonHomeIrohTransport');
    const { resolveActionCliCredentialTarget } = await import('./actionServerTarget');
    const serverUrl = 'https://action-seeded.example.test';
    const profile = await addServerProfile({ name: 'action-seeded', serverUrl, webappUrl: serverUrl, use: true });
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'action-home-account', session: 'fixture-terminal-enrollment' })).toString('base64url')}.signature`;
    await writeCredentialsTokenOnlyForServerId(profile.id, { token });
    const deps = { readCredentialsFn: readStoredCredentials,
      readCredentialsForServerIdFn: readStoredCredentialsForServerId, getServerProfileFn: getServerProfile };
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => { throw new Error('Fixture Home has not published its descriptor yet'); }));
    await expect(resolveActionCliCredentialTarget({ requestedServerId: profile.id, requireServerIdentityId: true, deps }))
      .rejects.toMatchObject({ code: 'server_identity_unavailable' });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({ features: {},
      capabilities: { serverIdentity: { serverIdentityId: 'srv_action_home' } },
      homeConnectionDescriptor: { v: 1, homeServerIdentityId: 'srv_action_home', canonicalServerUrl: serverUrl,
        revision: 1, endpoints: [{ kind: 'https', url: serverUrl }] } })));
    const transport = await prepareDaemonHomeIrohTransport({ runtime: null, profile, applicationCarrierEligibility: 'standard_only' });
    try {
      const credentials = await readStoredCredentialsForServerId(profile.id);
      expect(credentials).not.toBeNull();
      expect(await transport.verifyAuthenticated(credentials!.token)).toMatchObject({ status: 'ready' });
    } finally {
      await transport.release();
    }
    // A new CLI invocation initializes its configuration from the saved profile.
    reloadConfiguration();
    const byProfile = await resolveActionCliCredentialTarget({ requestedServerId: profile.id, requireServerIdentityId: true, deps });
    const byHome = await resolveActionCliCredentialTarget({ requestedServerId: 'srv_action_home', requireServerIdentityId: true, deps });
    expect(byProfile.fixedServer).toEqual({ serverId: profile.id, serverIdentityId: 'srv_action_home', serverApiUrl: serverUrl });
    expect(byHome).toEqual(byProfile);
    await expect(resolveActionCliCredentialTarget({ requestedServerId: 'srv_other_home', requireServerIdentityId: true, deps })).rejects.toThrow();
    const ambient = await resolveActionCliCredentialTarget({ requestedServerId: null, deps });
    expect(ambient).toMatchObject({ fixedServer: null, serverIdentityId: 'srv_action_home' });
    const widgetDeps = createCliActionDeps({ credentials: byProfile.credentials!, token, sessionId: 'action-scope-fixture', mode: 'plain', ctx: null,
      serverId: byProfile.fixedServer!.serverId, serverIdentityId: byProfile.fixedServer!.serverIdentityId,
      serverHttpBaseUrl: byProfile.fixedServer!.serverApiUrl });
    expect(widgetDeps.widgetAccountScope!()).toMatchObject({ serverId: 'srv_action_home', accountId: 'action-home-account' });
    const ambientWidgetDeps = createCliActionDeps({ credentials: ambient.credentials!, token, sessionId: 'action-scope-fixture', mode: 'plain', ctx: null,
      serverIdentityId: ambient.serverIdentityId });
    expect(ambientWidgetDeps.widgetAccountScope!()).toMatchObject({ serverId: 'srv_action_home', accountId: 'action-home-account' });
    const surface = { serverId: 'srv_action_home', accountId: 'action-home-account', owner: { kind: 'home' as const } };
    const context = { surface: 'cli' as const, serverId: profile.id, serverIdentityId: 'srv_action_home' };
    expect(await admitWidgetActionSurfaceV1(widgetDeps, surface, context)).toBeNull();
    expect(await admitWidgetActionSurfaceV1(widgetDeps, surface, { ...context, serverIdentityId: 'srv_other_home' }))
      .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(await admitWidgetActionSurfaceV1(widgetDeps, { ...surface, serverId: 'srv_other_home' }, context))
      .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    await updateSettings(settings => ({ ...settings, servers: { ...settings.servers,
      duplicate: { ...settings.servers![profile.id]!, id: 'duplicate' },
    } }));
    await expect(resolveActionCliCredentialTarget({ requestedServerId: profile.id, requireServerIdentityId: true, deps }))
      .rejects.toMatchObject({ code: 'server_identity_unavailable' });
  });
});
