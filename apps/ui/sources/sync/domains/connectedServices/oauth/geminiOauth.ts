export const GEMINI_OAUTH = Object.freeze({
  clientId: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  defaultRedirectUri: 'http://localhost:54545/oauth2callback',
  scopes: [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
  ].join(' '),
});

export function buildGeminiAuthorizationUrl(params: Readonly<{
  redirectUri: string;
  state: string;
  challenge: string;
}>): string {
  const query = new URLSearchParams({
    client_id: GEMINI_OAUTH.clientId,
    response_type: 'code',
    redirect_uri: params.redirectUri,
    scope: GEMINI_OAUTH.scopes,
    access_type: 'offline',
    code_challenge: params.challenge,
    code_challenge_method: 'S256',
    state: params.state,
    prompt: 'consent',
  });
  return `${GEMINI_OAUTH.authorizeUrl}?${query.toString()}`;
}
