import { afterEach, describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { encodeBase64 } from '@/encryption/base64';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

import {
  clearPendingExternalAuthMock,
  flushOAuthEffects,
  getRandomBytesSpy,
  localSearchParamsMock,
  loginSpy,
  loginWithCredentialsSpy,
  replaceSpy,
  resetOAuthHarness,
  setPendingExternalAuthState,
} from '@/auth/providers/github/test/oauthReturnHarness';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@shopify/react-native-skia', () => ({}));

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
    const { default: Screen } = await import('@/app/(app)/oauth/[provider]');
    const screen = await renderScreen(<Screen />);
    await flushOAuthEffects();
    expect(screen.findByTestId('oauth-return-wizard')).toBeTruthy();
    return screen;
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

    const fetchMock = vi.fn(async (url: any, init?: any) => {
      const rawUrl = String(url);
      if (isReachabilityProbeUrl(rawUrl)) {
        return new Response('', { status: 200 });
      }
      if (typeof url === 'string' && rawUrl.includes('/v1/auth/external/github/finalize-keyless')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (body?.pending !== 'p3' || body?.proof !== 'proof_3') {
          return new Response(JSON.stringify({ error: 'invalid' }), { status: 400 });
        }
        return new Response(JSON.stringify({ success: true, token: 'tok_3' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    });
    setRuntimeFetch(fetchMock as unknown as typeof fetch);

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
      await vi.waitFor(() => {
        expect(screen.findAllByTestId('oauth-provisioning-choice-plain')).toHaveLength(0);
        expect(fetchMock.mock.calls.some(([calledUrl]) => String(calledUrl).includes('/v1/auth/external/github/finalize-keyless'))).toBe(true);
        expect(clearPendingExternalAuthMock).toHaveBeenCalled();
        expect(loginWithCredentialsSpy).toHaveBeenCalledWith({ token: 'tok_3' });
        expect(loginSpy).not.toHaveBeenCalled();
        expect(getRandomBytesSpy).not.toHaveBeenCalled();
        expect(replaceSpy).toHaveBeenCalledWith('/');
      });
    } finally {
      await screen.unmount();
    }

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

    const fetchMock = vi.fn(async (url: any, init?: any) => {
      const rawUrl = String(url);
      if (isReachabilityProbeUrl(rawUrl)) {
        return new Response('', { status: 200 });
      }
      if (typeof url === 'string' && rawUrl.includes('/v1/auth/external/github/finalize-keyless')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (body?.pending !== 'p4' || body?.proof !== 'proof_4') {
          return new Response(JSON.stringify({ error: 'invalid' }), { status: 400 });
        }
        return new Response(JSON.stringify({ success: true, token: 'tok_4' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    });
    setRuntimeFetch(fetchMock as unknown as typeof fetch);

    const screen = await renderOAuthReturnScreen();
    try {
      await flushOAuthEffects(8);

      expect(fetchMock.mock.calls.some(([calledUrl]) => String(calledUrl).includes('/v1/auth/external/github/finalize-keyless'))).toBe(true);
      expect(clearPendingExternalAuthMock).toHaveBeenCalled();
      expect(loginWithCredentialsSpy).toHaveBeenCalledWith({ token: 'tok_4' });
      expect(loginSpy).not.toHaveBeenCalled();
      expect(getRandomBytesSpy).not.toHaveBeenCalled();
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
    setPendingExternalAuthState({ provider: 'github', proof: 'proof_5' });

    const fetchMock = vi.fn(async (url: any) => {
      const rawUrl = String(url);
      if (isReachabilityProbeUrl(rawUrl)) {
        return new Response('', { status: 200 });
      }
      if (rawUrl.includes('/v1/auth/external/github/finalize')) {
        return new Response(JSON.stringify({ success: true, token: 'tok_5' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    });
    setRuntimeFetch(fetchMock as unknown as typeof fetch);

    const screen = await renderOAuthReturnScreen();
    try {
      expect(getRandomBytesSpy).not.toHaveBeenCalled();
      expect(loginSpy).not.toHaveBeenCalled();
      expect(loginWithCredentialsSpy).not.toHaveBeenCalled();

      await pressTestInstanceAsync(
        screen.findByTestId('oauth-provisioning-choice-e2ee'),
        'oauth-provisioning-choice-e2ee',
      );

      await vi.waitFor(() => {
        expect(fetchMock.mock.calls.some(([calledUrl]) => String(calledUrl).includes('/v1/auth/external/github/finalize'))).toBe(true);
        expect(getRandomBytesSpy).toHaveBeenCalled();
        expect(loginSpy).toHaveBeenCalledWith(
          'tok_5',
          encodeBase64(new Uint8Array(32).fill(9), 'base64url'),
        );
        expect(loginWithCredentialsSpy).not.toHaveBeenCalled();
        expect(replaceSpy).toHaveBeenCalledWith('/');
      });
    } finally {
      await screen.unmount();
    }
  });
});
