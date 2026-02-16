import { describe, expect, it, vi } from 'vitest';

import { startOauthPkceWithPasteFallback } from './oauthPkceWithPasteFallback';

describe('startOauthPkceWithPasteFallback', () => {
  it('uses paste mode without binding a loopback server', async () => {
    const exchangeCodeForTokens = vi.fn(async () => ({ accessToken: 't1' }));
    const startLoopback = vi.fn(async () => ({ accessToken: 'loopback' }));

    const tokens = await startOauthPkceWithPasteFallback({
      mode: 'paste',
      defaultPort: 1455,
      callbackPath: '/auth/callback',
      generateState: () => 'state-1',
      generatePkce: () => ({ verifier: 'verifier-1', challenge: 'challenge-1' }),
      buildAuthorizationUrl: ({ redirectUri, state, challenge }) =>
        `https://example.com/oauth?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&challenge=${challenge}`,
      promptForPastedRedirectUrl: async () =>
        'http://localhost:1455/auth/callback?code=auth-code-1&state=state-1',
      exchangeCodeForTokens,
      startLoopbackOauthPkceFlowFn: startLoopback,
      openAuthorizationUrl: async () => {
        throw new Error('should not open browser in paste mode');
      },
    });

    expect(tokens).toEqual({ accessToken: 't1' });
    expect(startLoopback).not.toHaveBeenCalled();
    expect(exchangeCodeForTokens).toHaveBeenCalledWith({
      code: 'auth-code-1',
      verifier: 'verifier-1',
      state: 'state-1',
      port: 1455,
    });
  });
});

