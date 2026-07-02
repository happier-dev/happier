import type { CodexAuthTokens } from './types.js';
import {
  assertNonEmptyString,
  buildSafeOauthProviderFailureMessage,
  extractOpenAiAccountIdFromIdToken,
  OPENAI_CODEX_AUTH_BASE_URL,
  OPENAI_CODEX_CLIENT_ID,
} from './oauth.js';

export const OPENAI_CODEX_DEVICE_VERIFICATION_URL = `${OPENAI_CODEX_AUTH_BASE_URL}/codex/device`;
export const OPENAI_CODEX_DEVICE_REDIRECT_URI = `${OPENAI_CODEX_AUTH_BASE_URL}/deviceauth/callback`;

const OAUTH_POLLING_SAFETY_MARGIN_MS = 3_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function exchangeDeviceApprovalForTokens(params: Readonly<{
  fetcher: typeof fetch;
  now: number;
  authorizationCode: string;
  codeVerifier: string;
}>): Promise<CodexAuthTokens> {
  const response = await params.fetcher(`${OPENAI_CODEX_AUTH_BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: OPENAI_CODEX_CLIENT_ID,
      code: params.authorizationCode,
      code_verifier: params.codeVerifier,
      redirect_uri: OPENAI_CODEX_DEVICE_REDIRECT_URI,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(buildSafeOauthProviderFailureMessage({
      operation: 'Token exchange',
      status: response.status,
      statusText: response.statusText,
      body,
    }));
  }

  const data = (await response.json()) as unknown;
  const record = isRecord(data) ? data : {};
  const idToken = assertNonEmptyString(record.id_token, 'id_token');
  const refreshToken = assertNonEmptyString(record.refresh_token, 'refresh_token');
  const accessToken = typeof record.access_token === 'string' && record.access_token ? record.access_token : idToken;
  const expiresIn = typeof record.expires_in === 'number' ? record.expires_in : undefined;
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
  const sleep = params.sleep ?? (async (ms) => await new Promise((resolve) => setTimeout(resolve, ms)));

  const usercodeRes = await fetcher(`${OPENAI_CODEX_AUTH_BASE_URL}/api/accounts/deviceauth/usercode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: OPENAI_CODEX_CLIENT_ID }),
  });
  if (!usercodeRes.ok) {
    throw new Error(`Failed to initiate device authorization: ${usercodeRes.status}`);
  }
  const usercodeJson = (await usercodeRes.json()) as unknown;
  const usercodeRecord = isRecord(usercodeJson) ? usercodeJson : {};
  const deviceAuthId = assertNonEmptyString(usercodeRecord.device_auth_id, 'device_auth_id');
  const userCode = assertNonEmptyString(usercodeRecord.user_code, 'user_code');
  const intervalSeconds = Math.max(Number.parseInt(String(usercodeRecord.interval ?? '5'), 10) || 5, 1);
  const intervalMs = intervalSeconds * 1000;

  params.onUserCode?.({ verificationUrl: OPENAI_CODEX_DEVICE_VERIFICATION_URL, userCode });

  while (true) {
    const pollRes = await fetcher(`${OPENAI_CODEX_AUTH_BASE_URL}/api/accounts/deviceauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
    });

    if (pollRes.ok) {
      const pollJson = (await pollRes.json()) as unknown;
      const pollRecord = isRecord(pollJson) ? pollJson : {};
      const authorizationCode = assertNonEmptyString(pollRecord.authorization_code, 'authorization_code');
      const codeVerifier = assertNonEmptyString(pollRecord.code_verifier, 'code_verifier');
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
