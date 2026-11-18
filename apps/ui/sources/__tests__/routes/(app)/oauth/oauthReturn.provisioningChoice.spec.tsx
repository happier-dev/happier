import { ExternalOAuthFinalizeAuthSuccessResponseSchema } from '@happier-dev/protocol/auth/externalOAuth';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { encodeBase64 } from '@/encryption/base64';
import { resetRuntimeFetch } from '@/utils/system/runtimeFetch';
import { setOAuthRuntimeFetch as setRuntimeFetch, OAuthHarnessProvider, prepareOAuthHarness } from '@/auth/providers/github/test/oauthReturnHarness';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';

import {
  clearPendingExternalAuthMock,
  flushOAuthEffects,
  getRandomBytesSpy,
  localSearchParamsMock,
  replaceSpy,
  resetOAuthHarness,
  setActiveServerSnapshot,
  setPendingExternalAuthState,
  oauthDefaultHome,
} from '@/auth/providers/github/test/oauthReturnHarness';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;


afterEach(() => {
  vi.unstubAllGlobals();
  resetRuntimeFetch();
  resetOAuthHarness();
});

describe('oauth/[provider] return (provisioning choice)', () => {
  function isReachabilityProbeUrl(url: string): boolean {
    return url.endsWith('/health') || url.endsWith('/v1/auth/ping');
  }

  async function renderOAuthReturnScreen() {
    await prepareOAuthHarness();
    const { default: Screen } = await import('@/app/(app)/oauth/[provider]');
    const screen = await renderScreen(<OAuthHarnessProvider><Screen /></OAuthHarnessProvider>);
    await flushOAuthEffects();
    expect(screen.findByTestId('oauth-return-wizard')).toBeTruthy();
    return screen;
  }

  it('shows the encryption choice on optional servers and finalizes plaintext (keyless) when chosen', async () => {
    replaceSpy.mockReset();
    clearPendingExternalAuthMock.mockClear();

    localSearchParamsMock.mockReturnValue({
      provider: 'github',
      flow: 'auth',
      pending: 'p3',
      storagePolicy: 'optional',
      provisioning: 'required',
    });
    setPendingExternalAuthState({ ...oauthDefaultHome, provider: 'github', proof: 'proof_3' });

    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl = String(url);
      if (isReachabilityProbeUrl(rawUrl)) {
        return new Response('', { status: 200 });
      }
      if (typeof url === 'string' && rawUrl.includes('/v1/auth/external/github/finalize-keyless')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (body?.pending !== 'p3' || body?.proof !== 'proof_3') {
          return new Response(JSON.stringify({ error: 'invalid' }), { status: 400 });
        }
        return new Response(JSON.stringify(ExternalOAuthFinalizeAuthSuccessResponseSchema.parse({ success: true, token: createAccountTokenForTests('tok_3') })), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    });
    setRuntimeFetch(fetchMock);

    const screen = await renderOAuthReturnScreen();
    try {
      const nonReachabilityCalls = fetchMock.mock.calls.filter(([calledUrl]) => !isReachabilityProbeUrl(String(calledUrl)));
      expect(nonReachabilityCalls).toHaveLength(0);
      expect(replaceSpy).not.toHaveBeenCalledWith('/');

      const choice = screen.findByTestId('oauth-provisioning-choice-plain');
      expect(choice).toBeTruthy();
      if (!choice) {
        throw new Error('Expected oauth-provisioning-choice-plain to be rendered');
      }
      expect(typeof choice.props.onPress).toBe('function');

      await pressTestInstanceAsync(choice, 'oauth-provisioning-choice-plain');
      await vi.waitFor(async () => {
        expect(screen.findAllByTestId('oauth-provisioning-choice-plain')).toHaveLength(0);
        expect(fetchMock.mock.calls.some(([calledUrl]) => String(calledUrl).includes('/v1/auth/external/github/finalize-keyless'))).toBe(true);
        expect(clearPendingExternalAuthMock).toHaveBeenCalled();
        expect(await TokenStorage.getCredentials()).toEqual({ token: createAccountTokenForTests('tok_3') });
        expect(replaceSpy).toHaveBeenCalledWith('/');
      });
    } finally {
      await screen.unmount();
    }

  });

  it('persists and opens the immutable OAuth Home even when focus changes before finalization resolves', async () => {
    const profiles = await import('@/sync/domains/server/serverProfiles');
    const profile = await profiles.upsertServerProfile({
      serverUrl: 'https://oauth-home-a.test',
      source: 'manual',
    });
    await profiles.setServerProfileIdentityForUrl(profile.serverUrl, 'srv_oauth_home_a');
    setActiveServerSnapshot({
      serverId: 'srv_oauth_home_a',
      serverUrl: 'https://oauth-home-a.test',
      generation: 1,
    });
    localSearchParamsMock.mockReturnValue({
      provider: 'github',
      flow: 'auth',
      pending: 'p-exact-target',
      storagePolicy: 'optional',
      provisioning: 'required',
    });
    setPendingExternalAuthState({
      provider: 'github',
      proof: 'proof-exact-target',
      serverUrl: 'https://oauth-home-a.test',
      serverId: 'srv_oauth_home_a',
    });

    let resolveFinalize!: (response: Response) => void;
    const finalizeResponse = new Promise<Response>((resolve) => { resolveFinalize = resolve; });
    const fetchMock = vi.fn(async (url: unknown) => {
      const rawUrl = String(url);
      if (isReachabilityProbeUrl(rawUrl)) return new Response('', { status: 200 });
      if (rawUrl.includes('/v1/auth/external/github/finalize-keyless')) return await finalizeResponse;
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    });
    setRuntimeFetch(fetchMock);

    const screen = await renderOAuthReturnScreen();
    try {
      const choice = screen.findByTestId('oauth-provisioning-choice-plain');
      if (!choice) throw new Error('Expected plaintext provisioning choice');
      const press = pressTestInstanceAsync(choice, 'oauth-provisioning-choice-plain');
      await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) =>
        String(url).includes('/v1/auth/external/github/finalize-keyless'))).toBe(true));

      setActiveServerSnapshot({
        serverId: 'srv_oauth_home_b',
        serverUrl: 'https://oauth-home-b.test',
        generation: 2,
      });
      await prepareOAuthHarness();
      resolveFinalize(new Response(JSON.stringify(ExternalOAuthFinalizeAuthSuccessResponseSchema.parse({ success: true, token: createAccountTokenForTests('token-home-a') })), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
      await press;

      // The choice is the shared button, whose press settles before the finalize it started.
      await vi.waitFor(() => expect(profiles.getActiveServerId()).toBe('srv_oauth_home_a'));
      expect(await TokenStorage.getCredentialsForServerUrl('https://oauth-home-a.test', { serverId: 'srv_oauth_home_a' }))
        .toEqual({ token: createAccountTokenForTests('token-home-a') });
      expect(await TokenStorage.getCredentialsForServerUrl('https://oauth-home-b.test', { serverId: 'srv_oauth_home_b' })).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it('auto-finalizes plaintext (keyless) when provisioningModes only allows plain', async () => {
    replaceSpy.mockReset();
    clearPendingExternalAuthMock.mockClear();

    localSearchParamsMock.mockReturnValue({
      provider: 'github',
      flow: 'auth',
      pending: 'p4',
      storagePolicy: 'optional',
      provisioning: 'required',
      provisioningModes: 'plain',
    });
    setPendingExternalAuthState({ ...oauthDefaultHome, provider: 'github', proof: 'proof_4' });

    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl = String(url);
      if (isReachabilityProbeUrl(rawUrl)) {
        return new Response('', { status: 200 });
      }
      if (typeof url === 'string' && rawUrl.includes('/v1/auth/external/github/finalize-keyless')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (body?.pending !== 'p4' || body?.proof !== 'proof_4') {
          return new Response(JSON.stringify({ error: 'invalid' }), { status: 400 });
        }
        return new Response(JSON.stringify(ExternalOAuthFinalizeAuthSuccessResponseSchema.parse({ success: true, token: createAccountTokenForTests('tok_4') })), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    });
    setRuntimeFetch(fetchMock);

    const screen = await renderOAuthReturnScreen();
    try {
      await flushOAuthEffects(8);

      expect(fetchMock.mock.calls.some(([calledUrl]) => String(calledUrl).includes('/v1/auth/external/github/finalize-keyless'))).toBe(true);
      expect(clearPendingExternalAuthMock).toHaveBeenCalled();
      expect(await TokenStorage.getCredentials()).toEqual({ token: createAccountTokenForTests('tok_4') });
      expect(replaceSpy).toHaveBeenCalledWith('/');

      expect(screen.findAllByTestId('oauth-provisioning-choice-plain')).toHaveLength(0);
    } finally {
      await screen.unmount();
    }

  });

  it('provisions real E2EE material only after the user explicitly chooses E2EE', async () => {
    localSearchParamsMock.mockReturnValue({
      provider: 'github',
      flow: 'auth',
      pending: 'p5',
      storagePolicy: 'optional',
      provisioning: 'required',
    });
    setPendingExternalAuthState({ ...oauthDefaultHome, provider: 'github', proof: 'proof_5' });

    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const rawUrl = String(url);
      if (isReachabilityProbeUrl(rawUrl)) {
        return new Response('', { status: 200 });
      }
      if (rawUrl.includes('/v1/auth/external/github/finalize')) {
        return new Response(JSON.stringify(ExternalOAuthFinalizeAuthSuccessResponseSchema.parse({ success: true, token: createAccountTokenForTests('tok_5') })), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    });
    setRuntimeFetch(fetchMock);

    const screen = await renderOAuthReturnScreen();
    try {
      expect(getRandomBytesSpy).not.toHaveBeenCalled();
      expect(await TokenStorage.getCredentials()).toBeNull();

      await pressTestInstanceAsync(
        screen.findByTestId('oauth-provisioning-choice-e2ee'),
        'oauth-provisioning-choice-e2ee',
      );

      await vi.waitFor(async () => {
        expect(fetchMock.mock.calls.some(([calledUrl]) => String(calledUrl).includes('/v1/auth/external/github/finalize'))).toBe(true);
        expect(getRandomBytesSpy).toHaveBeenCalled();
        expect(await TokenStorage.getCredentials()).toEqual({ token: createAccountTokenForTests('tok_5'),
          secret: encodeBase64(new Uint8Array(32).fill(9), 'base64url') });
        expect(replaceSpy).toHaveBeenCalledWith('/');
      });
    } finally {
      await screen.unmount();
    }
  });
});
