import { decodeBase64 } from '@/encryption/base64';
import { runtimeFetch } from '@/utils/system/runtimeFetch';

export const OPENAI_CODEX_OAUTH = Object.freeze({
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  authBaseUrl: 'https://auth.openai.com',
  defaultRedirectUri: 'http://localhost:1455/auth/callback',
  scope: 'openid profile email offline_access',
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeDecodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const payloadBytes = decodeBase64(parts[1] ?? '', 'base64url');
    const json = new TextDecoder().decode(payloadBytes);
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function extractOpenAiAccountIdFromIdToken(idToken: string): string | null {
  const payload = safeDecodeJwtPayload(idToken);
  if (!payload) return null;

  const direct = payload.chatgpt_account_id;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();

  const authClaim = payload['https://api.openai.com/auth'];
  if (isRecord(authClaim)) {
    const nestedDirect = authClaim.chatgpt_account_id;
    if (typeof nestedDirect === 'string' && nestedDirect.trim()) return nestedDirect.trim();
    const nestedFallback = authClaim.account_id;
    if (typeof nestedFallback === 'string' && nestedFallback.trim()) return nestedFallback.trim();
  }

  return null;
}

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

export async function exchangeOpenAiCodexTokens(params: Readonly<{
  code: string;
  verifier: string;
  redirectUri: string;
  now: number;
}>): Promise<Readonly<{
  idToken: string;
  accessToken: string;
  refreshToken: string;
  providerAccountId: string | null;
  expiresAt: number | null;
}>> {
  const response = await runtimeFetch(`${OPENAI_CODEX_OAUTH.authBaseUrl}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: OPENAI_CODEX_OAUTH.clientId,
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
  const idToken = typeof data.id_token === 'string' ? data.id_token : '';
  const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token : '';
  const accessTokenRaw = typeof data.access_token === 'string' ? data.access_token : '';
  const accessToken = accessTokenRaw || idToken;
  if (!idToken || !accessToken || !refreshToken) {
    throw new Error('Token exchange returned invalid token payload');
  }

  const expiresIn = Number.isFinite(data.expires_in) ? Number(data.expires_in) : NaN;
  const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? params.now + Math.trunc(expiresIn) * 1000 : null;

  return {
    idToken,
    accessToken,
    refreshToken,
    providerAccountId: extractOpenAiAccountIdFromIdToken(idToken),
    expiresAt,
  };
}
