export const OPENAI_CODEX_OAUTH = Object.freeze({
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  authBaseUrl: 'https://auth.openai.com',
  defaultRedirectUri: 'http://localhost:1455/auth/callback',
  scope: 'openid profile email offline_access',
});

export function buildOpenAiCodexAuthorizationUrl(params: Readonly<{
  redirectUri: string;
  state: string;
  challenge: string;
}>): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: OPENAI_CODEX_OAUTH.clientId,
    redirect_uri: params.redirectUri,
    scope: OPENAI_CODEX_OAUTH.scope,
    code_challenge: params.challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state: params.state,
  });
  return `${OPENAI_CODEX_OAUTH.authBaseUrl}/oauth/authorize?${query.toString()}`;
}
