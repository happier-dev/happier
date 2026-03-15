import { describe, expect, it } from 'vitest';

import { exchangeClaudeSubscriptionAuthorizationCodeForTokens } from './authenticateClaudeSubscriptionOauth';

describe('exchangeClaudeSubscriptionAuthorizationCodeForTokens', () => {
  it('posts JSON to the Anthropic console token endpoint', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];

    const fetcher = (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        access_token: 'access',
        refresh_token: 'refresh',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'user:inference',
        account: { uuid: 'acct', email_address: 'user@example.com' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as any;

    const tokens = await exchangeClaudeSubscriptionAuthorizationCodeForTokens({
      code: 'code',
      verifier: 'verifier',
      redirectUri: 'http://localhost:54545/oauth2callback',
      state: 'state',
      fetcher,
    });

    expect(tokens.access_token).toBe('access');
    expect(tokens.refresh_token).toBe('refresh');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://console.anthropic.com/v1/oauth/token');
    expect(calls[0]!.init.method).toBe('POST');
    expect(String(calls[0]!.init.headers && (calls[0]!.init.headers as any)['Content-Type'])).toMatch(/application\/json/i);
    expect(typeof calls[0]!.init.body).toBe('string');
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      grant_type: 'authorization_code',
      client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
      code: 'code',
      code_verifier: 'verifier',
      redirect_uri: 'http://localhost:54545/oauth2callback',
      state: 'state',
    });
  });
});
