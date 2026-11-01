import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';

import {
  clearPendingExternalAuthMock,
  flushOAuthEffects,
  localSearchParamsMock,
  loginWithCredentialsSpy,
  replaceSpy,
  resetOAuthHarness,
  setPendingExternalAuthState,
} from '@/auth/providers/github/test/oauthReturnHarness';

const keylessToken = `header.${Buffer.from(JSON.stringify({ sub: 'account-provisioning' })).toString('base64url')}.signature`;
const serverFeatures = createRootLayoutFeaturesResponse({
  features: { encryption: { plaintextMachine: { enabled: true } } },
});

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@shopify/react-native-skia', () => ({}));

afterEach(() => {
  vi.unstubAllGlobals();
  resetServerFeaturesClientForTests();
  resetOAuthHarness();
});

describe('oauth/[provider] return (provisioning choice)', () => {
  function isReachabilityProbeUrl(url: string): boolean {
    return url.endsWith('/health') || url.endsWith('/v1/auth/ping');
  }

  async function renderOAuthReturnScreen() {
    const { default: Screen } = await import('@/app/(app)/oauth/[provider]');
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    await act(async () => {
      screen = await renderScreen(<Screen />);
    });
    await flushOAuthEffects();
    return screen!;
  }

  it('shows the encryption choice on optional servers and finalizes plaintext (keyless) when chosen', async () => {
    replaceSpy.mockReset();
    loginWithCredentialsSpy.mockReset();
    clearPendingExternalAuthMock.mockReset();

    localSearchParamsMock.mockReturnValue({
      provider: 'github',
      flow: 'auth',
      pending: 'p3',
      storagePolicy: 'optional',
      provisioning: 'required',
    });
    setPendingExternalAuthState({ provider: 'github', proof: 'proof_3' });

    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (url: any, init?: any) => {
      const rawUrl = String(url);
      if (rawUrl.endsWith('/v1/features')) {
        return new Response(JSON.stringify(serverFeatures), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      if (isReachabilityProbeUrl(rawUrl)) {
        return new Response('', { status: 200 });
      }
      if (typeof url === 'string' && rawUrl.includes('/v1/auth/external/github/finalize-keyless')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (body?.pending !== 'p3' || body?.proof !== 'proof_3') {
          return new Response(JSON.stringify({ error: 'invalid' }), { status: 400 });
        }
        return new Response(JSON.stringify({ success: true, token: keylessToken }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const screen = await renderOAuthReturnScreen();
    try {
      const shell = screen.findByTestId('unauth-shell-route-oauth-callback');
      expect(shell).toBeTruthy();
      expect(shell?.props.stepId).toBe('oauth-callback');
      expect(shell?.props.isWelcomeStep).toBe(false);
      expect(shell?.props.allowMobileBrandHero).toBe(false);
      expect(shell?.props.hasBack).toBe(false);

      const nonReachabilityCalls = fetchMock.mock.calls.filter(([calledUrl]) => !isReachabilityProbeUrl(String(calledUrl)));
      expect(nonReachabilityCalls).toHaveLength(0);
      expect(replaceSpy).not.toHaveBeenCalledWith('/');

      const choice = screen.findByTestId('oauth-provisioning-choice-plain');
      expect(choice).toBeTruthy();

      await pressTestInstanceAsync(choice, 'oauth-provisioning-choice-plain');
      await flushOAuthEffects(2);

      expect(fetchMock.mock.calls.some(([calledUrl]) => String(calledUrl).includes('/v1/auth/external/github/finalize-keyless'))).toBe(true);
      expect(clearPendingExternalAuthMock).toHaveBeenCalled();
      expect(loginWithCredentialsSpy).toHaveBeenCalledWith({ token: keylessToken });
      expect(replaceSpy).toHaveBeenCalledWith('/');
    } finally {
      await act(async () => {
        screen.tree.unmount();
      });
    }

    vi.stubGlobal('fetch', originalFetch);
  });

  it('auto-finalizes plaintext (keyless) when provisioningModes only allows plain', async () => {
    replaceSpy.mockReset();
    loginWithCredentialsSpy.mockReset();
    clearPendingExternalAuthMock.mockReset();

    localSearchParamsMock.mockReturnValue({
      provider: 'github',
      flow: 'auth',
      pending: 'p4',
      storagePolicy: 'optional',
      provisioning: 'required',
      provisioningModes: 'plain',
    });
    setPendingExternalAuthState({ provider: 'github', proof: 'proof_4' });

    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (url: any, init?: any) => {
      const rawUrl = String(url);
      if (rawUrl.endsWith('/v1/features')) {
        return new Response(JSON.stringify(serverFeatures), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      if (isReachabilityProbeUrl(rawUrl)) {
        return new Response('', { status: 200 });
      }
      if (typeof url === 'string' && rawUrl.includes('/v1/auth/external/github/finalize-keyless')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (body?.pending !== 'p4' || body?.proof !== 'proof_4') {
          return new Response(JSON.stringify({ error: 'invalid' }), { status: 400 });
        }
        return new Response(JSON.stringify({ success: true, token: keylessToken }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const screen = await renderOAuthReturnScreen();
    try {
      await flushOAuthEffects(8);

      expect(fetchMock.mock.calls.some(([calledUrl]) => String(calledUrl).includes('/v1/auth/external/github/finalize-keyless'))).toBe(true);
      expect(clearPendingExternalAuthMock).toHaveBeenCalled();
      expect(loginWithCredentialsSpy).toHaveBeenCalledWith({ token: keylessToken });
      expect(replaceSpy).toHaveBeenCalledWith('/');

      expect(screen.findAllByTestId('oauth-provisioning-choice-plain')).toHaveLength(0);
    } finally {
      await act(async () => {
        screen.tree.unmount();
      });
    }

    vi.stubGlobal('fetch', originalFetch);
  });
});
