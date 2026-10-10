import {
  AGY_OAUTH_AUTHORIZE_URL,
  AGY_OAUTH_CALLBACK_URL,
  AGY_OAUTH_CLIENT_ID,
  AGY_OAUTH_SCOPES,
} from '@happier-dev/agents';

export const ANTIGRAVITY_OAUTH = Object.freeze({
  clientId: AGY_OAUTH_CLIENT_ID,
  authorizeUrl: AGY_OAUTH_AUTHORIZE_URL,
  defaultRedirectUri: AGY_OAUTH_CALLBACK_URL,
  scopes: AGY_OAUTH_SCOPES.join(' '),
});

/** Requests offline ACP permissions with state and PKCE for a native loopback or return-URL paste flow. */
export function buildAntigravityAuthorizationUrl(params: Readonly<{
  redirectUri: string;
  state: string;
  challenge: string;
}>): string {
  const query = new URLSearchParams({
    client_id: ANTIGRAVITY_OAUTH.clientId,
    response_type: 'code',
    redirect_uri: params.redirectUri,
    scope: ANTIGRAVITY_OAUTH.scopes,
    access_type: 'offline',
    code_challenge: params.challenge,
    code_challenge_method: 'S256',
    state: params.state,
    prompt: 'consent',
  });
  return `${ANTIGRAVITY_OAUTH.authorizeUrl}?${query.toString()}`;
}
