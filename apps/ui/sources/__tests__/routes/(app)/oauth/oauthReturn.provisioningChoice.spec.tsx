import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import {
  clearPendingExternalAuthMock,
  flushOAuthEffects,
  localSearchParamsMock,
  loginWithCredentialsSpy,
  replaceSpy,
  resetOAuthHarness,
  runWithOAuthScreen,
  setPendingExternalAuthState,
} from '@/auth/providers/github/test/oauthReturnHarness';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@shopify/react-native-skia', () => ({}));

afterEach(() => {
  vi.unstubAllGlobals();
  resetOAuthHarness();
});

describe('oauth/[provider] return (provisioning choice)', () => {
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
      if (typeof url === 'string' && url.includes('/v1/auth/external/github/finalize-keyless')) {
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
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await runWithOAuthScreen(async (tree) => {
      await flushOAuthEffects();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(replaceSpy).not.toHaveBeenCalledWith('/');

      const choice = tree.root.findByProps({ testID: 'oauth-provisioning-choice-plain' });
      expect(typeof choice.props.onPress).toBe('function');

      await act(async () => {
        choice.props.onPress();
      });
      await flushOAuthEffects(2);

      expect(fetchMock).toHaveBeenCalled();
      expect(clearPendingExternalAuthMock).toHaveBeenCalled();
      expect(loginWithCredentialsSpy).toHaveBeenCalled();
      expect(replaceSpy).toHaveBeenCalledWith('/');
    });

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
      if (typeof url === 'string' && url.includes('/v1/auth/external/github/finalize-keyless')) {
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
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await runWithOAuthScreen(async (tree) => {
      await flushOAuthEffects(8);

      expect(fetchMock).toHaveBeenCalled();
      expect(clearPendingExternalAuthMock).toHaveBeenCalled();
      expect(loginWithCredentialsSpy).toHaveBeenCalled();
      expect(replaceSpy).toHaveBeenCalledWith('/');

      expect(tree.root.findAllByProps({ testID: 'oauth-provisioning-choice-plain' })).toHaveLength(0);
    });

    vi.stubGlobal('fetch', originalFetch);
  });
});
