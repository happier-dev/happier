import { runtimeFetch } from '@/utils/system/runtimeFetch';

export const GEMINI_OAUTH = Object.freeze({
  clientId: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  defaultRedirectUri: 'http://localhost:54545/oauth2callback',
  scopes: [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
  ].join(' '),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

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

export async function exchangeGeminiTokens(params: Readonly<{
  code: string;
  verifier: string;
  redirectUri: string;
  now: number;
}>): Promise<Readonly<{
  accessToken: string;
  refreshToken: string;
  tokenType: string | null;
  scope: string | null;
  idToken: string | null;
  expiresAt: number | null;
  raw: unknown;
}>> {
  const response = await runtimeFetch(GEMINI_OAUTH.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: GEMINI_OAUTH.clientId,
      code: params.code,
      code_verifier: params.verifier,
      redirect_uri: params.redirectUri,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Token exchange failed: ${response.status} ${errorText}`.trim());
  }

  const json: unknown = await response.json();
  const data = isRecord(json) ? json : {};
  const accessToken = typeof data.access_token === 'string' ? data.access_token : '';
  const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token : '';
  if (!accessToken || !refreshToken) {
    throw new Error('Token exchange returned invalid token payload');
  }

  const expiresIn = Number.isFinite(data.expires_in) ? Number(data.expires_in) : NaN;
  const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? params.now + Math.trunc(expiresIn) * 1000 : null;

  return {
    accessToken,
    refreshToken,
    tokenType: typeof data.token_type === 'string' ? data.token_type : null,
    scope: typeof data.scope === 'string' ? data.scope : null,
    idToken: typeof data.id_token === 'string' ? data.id_token : null,
    expiresAt,
    raw: data,
  };
}
