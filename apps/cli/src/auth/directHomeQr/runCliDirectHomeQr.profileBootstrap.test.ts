import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseHomeQrInviteV2Payload, type HomeConnectionDescriptorV1 } from '@happier-dev/protocol';

import { reloadConfiguration } from '@/configuration';
import { updateSettings, writeCredentialsTokenOnlyForServerId } from '@/persistence';
import { adoptServerProfileHomeConnectionDescriptor, getServerProfile, setServerProfileEndpointsById } from '@/server/serverProfiles';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

import { runCliDirectHomeQr } from './runCliDirectHomeQr';

describe('direct Home QR from authenticated URL-only profiles', () => {
  const envScope = createEnvKeyScope([
    'HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL',
    'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_HOME_CARRIER_POLICY',
  ]);

  afterEach(() => {
    envScope.restore();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function runCase(input: Readonly<{
    source: 'stack' | 'predecessor';
    publicFallback?: boolean;
    mismatchedIdentity?: boolean;
    advisory?: boolean;
    origin?: string;
    localOrigin?: string;
    unauthorized?: boolean;
    boundQrDisabled?: boolean;
  }>) {
    const nowMs = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(nowMs);
    return await withTempDir('happier-cli-profile-bootstrap-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined, HAPPIER_ACTIVE_SERVER_ID: undefined,
        HAPPIER_HOME_CARRIER_POLICY: 'standard_only',
      });
      reloadConfiguration();
      const origin = input.origin ?? 'https://profile-home.example.test';
      const id = input.source === 'stack' ? 'stack_qa__id_default' : 'predecessor-home';
      if (input.source === 'stack') {
        // Stack's endpoint synchronization creates this descriptor-less profile;
        // copy-from supplies the scoped access.key separately.
        await setServerProfileEndpointsById({
          id, serverUrl: origin, webappUrl: origin, use: true,
          ...(input.localOrigin ? { localServerUrl: input.localOrigin } : {}),
        });
      } else {
        // URL-only persisted shape from ../0.2 serverProfiles.ts at e0c5625670ae6b50236e5aae1fef67fc1b737853.
        await updateSettings((current) => ({
          ...current, activeServerId: id,
          servers: { ...current.servers, [id]: {
            id, name: 'predecessor-home', serverUrl: origin, webappUrl: origin,
            createdAt: 1, updatedAt: 1, lastUsedAt: 1,
            ...(input.localOrigin ? { localServerUrl: input.localOrigin } : {}),
          } },
        }));
      }
      await writeCredentialsTokenOnlyForServerId(id, { token: 'fixture-home-token' });
      const descriptor: HomeConnectionDescriptorV1 = {
        v: 1, homeServerIdentityId: 'srv_profile_home', canonicalServerUrl: origin,
        revision: 1, endpoints: [{ kind: 'https', url: origin }],
      };
      if (input.advisory) {
        await adoptServerProfileHomeConnectionDescriptor({ descriptor, expectedProfileId: id, observation: 'advisory' });
      }
      const controller = new AbortController();
      const requests: Array<{ origin: string; path: string }> = [];
      // Network is the only mocked system boundary: feature parsing, trust,
      // carrier selection, profile persistence and QR lifecycle stay real.
      vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
        const target = new URL(String(url));
        requests.push({ origin: target.origin, path: target.pathname });
        if (target.pathname === '/v1/features/authenticated' && input.unauthorized) {
          return new Response(null, { status: 401 });
        }
        if (target.pathname === '/v1/features/authenticated' && input.publicFallback) {
          return new Response(null, { status: 404 });
        }
        if (target.pathname.startsWith('/v1/features')) {
          if (target.pathname.endsWith('/authenticated')) {
            expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-home-token');
          }
          return Response.json({
            features: { auth: { pairing: { boundQrV2: { enabled: !input.boundQrDisabled } } } },
            capabilities: { serverIdentity: { serverIdentityId: input.mismatchedIdentity ? 'srv_other_home' : descriptor.homeServerIdentityId } },
            homeConnectionDescriptor: descriptor,
          });
        }
        if (target.pathname === '/v1/auth/pairing/start') {
          return Response.json({ pairId: 'fixture-pair', expiresAt: new Date(Date.now() + 60_000).toISOString() });
        }
        if (target.pathname === '/v1/auth/pairing/status') {
          return await new Promise<Response>((_resolve, reject) => {
            const abort = () => reject(new DOMException('Pairing cancelled', 'AbortError'));
            if (init?.signal?.aborted) abort();
            else init?.signal?.addEventListener('abort', abort, { once: true });
          });
        }
        if (target.pathname === '/v1/auth/pairing/consume') return new Response(null, { status: 204 });
        throw new Error(`Unexpected network request: ${target.pathname}`);
      }));
      let inviteHome: HomeConnectionDescriptorV1 | null = null;
      const result = await runCliDirectHomeQr({
        profileRef: id, copyLink: true, signal: controller.signal,
        onInvite: ({ link }) => {
          const payload = new URL(link).searchParams.get('payload');
          inviteHome = payload ? parseHomeQrInviteV2Payload(payload, { nowMs })?.home ?? null : null;
          controller.abort();
        },
      });
      return { result, inviteHome, requests, profile: await getServerProfile(id), descriptor };
    });
  }

  it.each(['stack', 'predecessor'] as const)('establishes the exact descriptor for a %s-authenticated profile before emitting an invite', async (source) => {
    const outcome = await runCase({ source });
    expect(outcome.result).toEqual({ kind: 'cancelled' });
    expect(outcome.inviteHome).toEqual(outcome.descriptor);
    expect(outcome.profile).toMatchObject({ homeConnectionDescriptor: outcome.descriptor, homeConnectionDescriptorAuthority: 'exact' });
    expect(outcome.requests.every((request) => request.origin === outcome.descriptor.canonicalServerUrl)).toBe(true);
  });

  it('does not exact-adopt the public fallback on a predecessor server', async () => {
    const outcome = await runCase({ source: 'predecessor', publicFallback: true });
    expect(outcome.result).toEqual({ kind: 'update_required' });
    expect(outcome.inviteHome).toBeNull();
    expect(outcome.profile.homeConnectionDescriptor).toBeUndefined();
  });

  it('establishes the descriptor through the Stack-owned loopback origin', async () => {
    const outcome = await runCase({ source: 'stack', localOrigin: 'http://127.0.0.1:3015' });
    expect(outcome.result).toEqual({ kind: 'cancelled' });
    expect(outcome.inviteHome).toEqual(outcome.descriptor);
    expect(outcome.profile.homeConnectionDescriptorAuthority).toBe('exact');
    expect(outcome.requests.every((request) => request.origin === 'http://127.0.0.1:3015')).toBe(true);
  });

  it('rejects inconsistent authenticated Home identity without persisting or pairing', async () => {
    const outcome = await runCase({ source: 'stack', mismatchedIdentity: true });
    expect(outcome.result).toEqual({ kind: 'failed', status: 412 });
    expect(outcome.inviteHome).toBeNull();
    expect(outcome.profile.homeConnectionDescriptor).toBeUndefined();
  });

  it('retains the trust guard for an advisory profile', async () => {
    const outcome = await runCase({ source: 'stack', advisory: true });
    expect(outcome.result).toEqual({ kind: 'failed', status: 412 });
    expect(outcome.requests).toEqual([]);
    expect(outcome.profile.homeConnectionDescriptorAuthority).toBe('advisory');
  });

  it('does not establish a descriptor before the Home admits bound QR pairing', async () => {
    const outcome = await runCase({ source: 'stack', boundQrDisabled: true });
    expect(outcome.result).toEqual({ kind: 'update_required' });
    expect(outcome.inviteHome).toBeNull();
    expect(outcome.profile.homeConnectionDescriptor).toBeUndefined();
  });

  it('never sends credentials to an ineligible remote HTTP origin', async () => {
    const outcome = await runCase({ source: 'predecessor', origin: 'http://untrusted.example.test' });
    expect(outcome.result).toEqual({ kind: 'failed', status: 412 });
    expect(outcome.requests).toEqual([]);
    expect(outcome.profile.homeConnectionDescriptor).toBeUndefined();
  });

  it('does not establish authority from a rejected credential', async () => {
    const outcome = await runCase({ source: 'stack', unauthorized: true });
    expect(outcome.inviteHome).toBeNull();
    expect(outcome.profile.homeConnectionDescriptor).toBeUndefined();
    expect(outcome.requests.map((request) => request.path)).toEqual(['/v1/features/authenticated']);
  });
});
