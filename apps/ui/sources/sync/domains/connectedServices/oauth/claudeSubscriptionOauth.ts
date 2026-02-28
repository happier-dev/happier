export const CLAUDE_SUBSCRIPTION_OAUTH = Object.freeze({
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authBaseUrl: 'https://claude.ai',
  defaultRedirectUri: 'https://platform.claude.com/oauth/code/callback',
  scope: 'user:inference',
});

export function buildClaudeSubscriptionAuthorizationUrl(params: Readonly<{
  redirectUri: string;
  state: string;
  challenge: string;
}>): string {
  // Claude.ai uses a slightly non-standard authorize flow where `code=true` triggers showing a code and redirect.
  const query = new URLSearchParams({
    code: 'true',
    client_id: CLAUDE_SUBSCRIPTION_OAUTH.clientId,
    response_type: 'code',
    redirect_uri: params.redirectUri,
    scope: CLAUDE_SUBSCRIPTION_OAUTH.scope,
    code_challenge: params.challenge,
    code_challenge_method: 'S256',
    state: params.state,
  });
  return `${CLAUDE_SUBSCRIPTION_OAUTH.authBaseUrl}/oauth/authorize?${query.toString()}`;
}
