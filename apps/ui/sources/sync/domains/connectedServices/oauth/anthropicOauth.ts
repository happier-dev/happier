import { runtimeFetch } from '@/utils/system/runtimeFetch';

export const ANTHROPIC_OAUTH = Object.freeze({
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authorizeUrl: 'https://claude.ai/oauth/authorize',
  tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
  defaultRedirectUri: 'http://localhost:54545/callback',
  scope: 'user:inference',
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function buildAnthropicAuthorizationUrl(params: Readonly<{
  redirectUri: string;
  state: string;
  challenge: string;
}>): string {
  const query = new URLSearchParams({
    code: 'true',
    client_id: ANTHROPIC_OAUTH.clientId,
    response_type: 'code',
    redirect_uri: params.redirectUri,
    scope: ANTHROPIC_OAUTH.scope,
    code_challenge: params.challenge,
    code_challenge_method: 'S256',
    state: params.state,
  });
  return `${ANTHROPIC_OAUTH.authorizeUrl}?${query.toString()}`;
}

export async function exchangeAnthropicTokens(params: Readonly<{
  code: string;
  verifier: string;
  state: string;
  redirectUri: string;
  now: number;
}>): Promise<Readonly<{
  accessToken: string;
  refreshToken: string;
  tokenType: string | null;
  scope: string | null;
  providerAccountId: string | null;
  providerEmail: string | null;
  expiresAt: number | null;
  raw: unknown;
}>> {
  const response = await runtimeFetch(ANTHROPIC_OAUTH.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: ANTHROPIC_OAUTH.clientId,
      code_verifier: params.verifier,
      state: params.state,
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

  const account = isRecord(data.account) ? data.account : null;
  const providerAccountId = typeof account?.uuid === 'string' ? account.uuid : null;
  const providerEmail = typeof account?.email_address === 'string' ? account.email_address : null;
  const tokenType = typeof data.token_type === 'string' ? data.token_type : null;
  const scope = typeof data.scope === 'string' ? data.scope : null;

  return {
    accessToken,
    refreshToken,
    tokenType,
    scope,
    providerAccountId,
    providerEmail,
    expiresAt,
    raw: data,
  };
}
