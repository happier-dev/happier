import { describe, expect, it } from 'vitest';
import { MCP_OAUTH_CALLBACK_URL_V1 } from '../mcp/oauth/mcpOAuthClientIdentityV1.js';
import { PluginConnectedAccountAuthenticationModeV2Schema } from './pluginConnectedAccountAuthenticationV2.js';
import {
  CONNECTED_ACCOUNT_OAUTH_CALLBACK_URL_V1,
  parseOauthAuthorizationResponse,
  resolveConnectedAccountOAuthCallbackUrlV1,
} from './oauthAuthorizationResponse.js';

describe('OAuth authorization response issuer', () => {
  it.each(['?code=code&state=attempt.random&iss=https%3A%2F%2Fissuer.example', '#code=code&state=attempt.random&iss=https%3A%2F%2Fissuer.example'])(
    'preserves issuer from the callback %s', (query) => {
      expect(parseOauthAuthorizationResponse({ input: `https://cloud.happier.dev/oauth/mcp/callback${query}` })).toEqual({
        kind: 'callback', code: 'code', state: 'attempt.random', iss: 'https://issuer.example',
      });
    },
  );
  it('preserves issuer on error responses for admission before displaying provider errors', () => {
    expect(parseOauthAuthorizationResponse({ input: 'https://cloud.happier.dev/oauth/mcp/callback?error=access_denied&iss=https%3A%2F%2Fevil.example' }))
      .toEqual({ kind: 'callback', error: 'access_denied', iss: 'https://evil.example' });
  });
  it('does not reinterpret a present empty issuer as omission', () => {
    expect(parseOauthAuthorizationResponse({ input: 'https://cloud.happier.dev/oauth/mcp/callback?code=code&state=state&iss=' }))
      .toEqual({ kind: 'callback', code: 'code', state: 'state', iss: '' });
  });
});

describe('Connected Account OAuth callback', () => {
  const qaWebapp = 'http://happier-qa.localhost:19364';
  const qaCallback = `${qaWebapp}/oauth/connected-account/callback`;

  it("is the relay at the Home's web app, or the hosted web app when the Home advertises none", () => {
    expect(CONNECTED_ACCOUNT_OAUTH_CALLBACK_URL_V1).toBe('https://cloud.happier.dev/oauth/connected-account/callback');
    expect(resolveConnectedAccountOAuthCallbackUrlV1({})).toBe(CONNECTED_ACCOUNT_OAUTH_CALLBACK_URL_V1);
    expect(resolveConnectedAccountOAuthCallbackUrlV1({ homeWebappUrl: `${qaWebapp}/` })).toBe(qaCallback);
    expect(resolveConnectedAccountOAuthCallbackUrlV1({ homeWebappUrl: 'https://home.example/ui' }))
      .toBe('https://home.example/ui/oauth/connected-account/callback');
  });

  it('never redirects to a non-web address the Home advertises', () => {
    expect(resolveConnectedAccountOAuthCallbackUrlV1({ homeWebappUrl: 'javascript:alert(1)' })).toBe(CONNECTED_ACCOUNT_OAUTH_CALLBACK_URL_V1);
    expect(resolveConnectedAccountOAuthCallbackUrlV1({ homeWebappUrl: 'not a url' })).toBe(CONNECTED_ACCOUNT_OAUTH_CALLBACK_URL_V1);
  });

  it('keeps a callback the mode declares for itself', () => {
    expect(resolveConnectedAccountOAuthCallbackUrlV1({ declared: MCP_OAUTH_CALLBACK_URL_V1, homeWebappUrl: qaWebapp }))
      .toBe(MCP_OAUTH_CALLBACK_URL_V1);
  });

  it("lets an authorization-code mode omit its callback to use the Home's relay", () => {
    expect(PluginConnectedAccountAuthenticationModeV2Schema.safeParse({
      id: 'oauth', kind: 'oauthAuthorizationCode', pkce: 'required', outcomeReconciliation: 'none',
    }).success).toBe(true);
  });
});
