import type { CodexAuthTokens } from './authenticate';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const ISSUER = 'https://auth.openai.com';

export const OPENAI_CODEX_DEVICE_VERIFICATION_URL = `${ISSUER}/codex/device`;
export const OPENAI_CODEX_DEVICE_REDIRECT_URI = `${ISSUER}/deviceauth/callback`;

const OAUTH_POLLING_SAFETY_MARGIN_MS = 3_000;

function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function parseJWT(token: string): any {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }

  const payload = Buffer.from(parts[1], 'base64url').toString();
  return JSON.parse(payload);
}

function extractOpenAiAccountIdFromIdToken(idToken: string): string {
  const idTokenPayload = parseJWT(idToken);
  let accountId = idTokenPayload.chatgpt_account_id;
  if (!accountId) {
    const authClaim = idTokenPayload['https://api.openai.com/auth'];
    if (authClaim && typeof authClaim === 'object') {
      accountId = authClaim.chatgpt_account_id || authClaim.account_id;
    }
  }
  return String(accountId ?? '');
}

async function exchangeDeviceApprovalForTokens(params: Readonly<{
  fetcher: typeof fetch;
  now: number;
  authorizationCode: string;
  codeVerifier: string;
}>): Promise<CodexAuthTokens> {
  const response = await params.fetcher(`${ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code: params.authorizationCode,
      code_verifier: params.codeVerifier,
      redirect_uri: OPENAI_CODEX_DEVICE_REDIRECT_URI,
    }),
  });

  if (!response.ok) {
    const error = await response.text().catch(() => '');
    throw new Error(`Token exchange failed: ${response.status} ${error}`.trim());
  }

  const data = (await response.json()) as any;
  const idToken = assertNonEmptyString(data?.id_token, 'id_token');
  const refreshToken = assertNonEmptyString(data?.refresh_token, 'refresh_token');
  const accessToken = typeof data?.access_token === 'string' && data.access_token ? data.access_token : idToken;
  const expiresIn = typeof data?.expires_in === 'number' ? data.expires_in : undefined;
  const accountId = extractOpenAiAccountIdFromIdToken(idToken);

  return {
    id_token: idToken,
    access_token: accessToken,
    refresh_token: refreshToken,
    account_id: accountId,
    expires_in: expiresIn,
    expires_at: expiresIn && Number.isFinite(expiresIn) && expiresIn > 0 ? params.now + Math.trunc(expiresIn) * 1000 : null,
  };
}

export async function authenticateCodexDevice(params: Readonly<{
  fetcher?: typeof fetch;
  now: number;
  sleep?: (ms: number) => Promise<void>;
  onUserCode?: (params: { verificationUrl: string; userCode: string }) => void;
}>): Promise<CodexAuthTokens> {
  const fetcher = params.fetcher ?? fetch;
  const sleep = params.sleep ?? (async (ms) => await new Promise((r) => setTimeout(r, ms)));

  const usercodeRes = await fetcher(`${ISSUER}/api/accounts/deviceauth/usercode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });
  if (!usercodeRes.ok) {
    throw new Error(`Failed to initiate device authorization: ${usercodeRes.status}`);
  }
  const usercodeJson = (await usercodeRes.json()) as any;
  const deviceAuthId = assertNonEmptyString(usercodeJson?.device_auth_id, 'device_auth_id');
  const userCode = assertNonEmptyString(usercodeJson?.user_code, 'user_code');
  const intervalSeconds = Math.max(Number.parseInt(String(usercodeJson?.interval ?? '5'), 10) || 5, 1);
  const intervalMs = intervalSeconds * 1000;

  params.onUserCode?.({ verificationUrl: OPENAI_CODEX_DEVICE_VERIFICATION_URL, userCode });

  while (true) {
    const pollRes = await fetcher(`${ISSUER}/api/accounts/deviceauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
    });

    if (pollRes.ok) {
      const pollJson = (await pollRes.json()) as any;
      const authorizationCode = assertNonEmptyString(pollJson?.authorization_code, 'authorization_code');
      const codeVerifier = assertNonEmptyString(pollJson?.code_verifier, 'code_verifier');
      return await exchangeDeviceApprovalForTokens({
        fetcher,
        now: params.now,
        authorizationCode,
        codeVerifier,
      });
    }

    if (pollRes.status !== 403 && pollRes.status !== 404) {
      throw new Error(`Device authorization failed: ${pollRes.status}`);
    }

    await sleep(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS);
  }
}
