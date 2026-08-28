import { sleep as sdkSleep } from '@happier-dev/plugin-sdk/async';
import { OPENAI_CODEX_OAUTH_PROFILE } from '../../../../../connectedAccounts/openAiCodexProfile.js';
import type { HttpService } from '@happier-dev/plugin-sdk/http';

import type { CodexAuthTokens } from './types.js';
import {
  assertNonEmptyString,
  buildSafeOauthProviderFailureMessage,
  extractOpenAiAccountIdFromIdToken,
} from './oauth.js';

const DEFAULT_DEVICE_AUTHORIZATION_TTL_MS = 15 * 60_000;
const DEFAULT_DEVICE_POLL_INTERVAL_MS = 5_000;
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3_000;

export type CodexDeviceAuthorization = Readonly<{
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  expiresAtMs: number;
  pollIntervalMs: number;
}>;

export type CodexDeviceAuthorizationPollResult =
  | Readonly<{ status: 'pending'; retryAfterMs: number }>
  | Readonly<{ status: 'authorized'; tokens: CodexAuthTokens }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonBody(body: Uint8Array): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(body));
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function readPositiveSeconds(value: unknown, fallbackMs: number): number {
  const seconds = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(seconds) && seconds > 0
    ? seconds * 1_000
    : fallbackMs;
}

async function exchangeDeviceApprovalForTokens(params: Readonly<{
  http: Pick<HttpService, 'request'>;
  now: number;
  signal?: AbortSignal;
  authorizationCode: string;
  codeVerifier: string;
}>): Promise<CodexAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: OPENAI_CODEX_OAUTH_PROFILE.clientId,
    code: params.authorizationCode,
    code_verifier: params.codeVerifier,
    redirect_uri: OPENAI_CODEX_OAUTH_PROFILE.device.redirectUri,
  });
  const response = await params.http.request({
    url: OPENAI_CODEX_OAUTH_PROFILE.tokenUrl,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new TextEncoder().encode(body.toString()),
    redirect: 'error',
  }, params.signal ? { signal: params.signal } : undefined);

  if (response.status < 200 || response.status >= 300) {
    throw new Error(buildSafeOauthProviderFailureMessage({
      operation: 'Token exchange',
      status: response.status,
      body: new TextDecoder().decode(response.body),
    }));
  }

  const record = parseJsonBody(response.body);
  const idToken = assertNonEmptyString(record.id_token, 'id_token');
  const refreshToken = assertNonEmptyString(record.refresh_token, 'refresh_token');
  const accessToken = typeof record.access_token === 'string' && record.access_token
    ? record.access_token
    : idToken;
  const expiresIn = typeof record.expires_in === 'number' ? record.expires_in : undefined;
  const accountId = extractOpenAiAccountIdFromIdToken(idToken);

  return {
    id_token: idToken,
    access_token: accessToken,
    refresh_token: refreshToken,
    account_id: accountId,
    expires_in: expiresIn,
    expires_at: expiresIn && Number.isFinite(expiresIn) && expiresIn > 0
      ? params.now + Math.trunc(expiresIn) * 1000
      : null,
  };
}

export async function beginCodexDeviceAuthorization(params: Readonly<{
  http: Pick<HttpService, 'request'>;
  now: number;
  signal?: AbortSignal;
}>): Promise<CodexDeviceAuthorization> {
  const response = await params.http.request({
    url: OPENAI_CODEX_OAUTH_PROFILE.device.userCodeUrl,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({ client_id: OPENAI_CODEX_OAUTH_PROFILE.clientId })),
    redirect: 'error',
  }, params.signal ? { signal: params.signal } : undefined);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Failed to initiate device authorization: ${response.status}`);
  }
  const record = parseJsonBody(response.body);
  const deviceAuthId = assertNonEmptyString(record.device_auth_id, 'device_auth_id');
  const userCode = assertNonEmptyString(record.user_code, 'user_code');
  const pollIntervalMs = readPositiveSeconds(
    record.interval,
    DEFAULT_DEVICE_POLL_INTERVAL_MS,
  );
  const ttlMs = readPositiveSeconds(
    record.expires_in,
    DEFAULT_DEVICE_AUTHORIZATION_TTL_MS,
  );
  return Object.freeze({
    deviceAuthId,
    userCode,
    verificationUrl: OPENAI_CODEX_OAUTH_PROFILE.device.verificationUrl,
    expiresAtMs: params.now + ttlMs,
    pollIntervalMs,
  });
}

export async function pollCodexDeviceAuthorization(params: Readonly<{
  http: Pick<HttpService, 'request'>;
  now: number;
  signal?: AbortSignal;
  deviceAuthId: string;
  userCode: string;
  pollIntervalMs: number;
}>): Promise<CodexDeviceAuthorizationPollResult> {
  const response = await params.http.request({
    url: OPENAI_CODEX_OAUTH_PROFILE.device.tokenUrl,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({
      device_auth_id: params.deviceAuthId,
      user_code: params.userCode,
    })),
    redirect: 'error',
  }, params.signal ? { signal: params.signal } : undefined);

  if (response.status === 403 || response.status === 404) {
    return {
      status: 'pending',
      retryAfterMs: Math.max(params.pollIntervalMs, 1_000) + OAUTH_POLLING_SAFETY_MARGIN_MS,
    };
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Device authorization failed: ${response.status}`);
  }
  const record = parseJsonBody(response.body);
  const authorizationCode = assertNonEmptyString(
    record.authorization_code,
    'authorization_code',
  );
  const codeVerifier = assertNonEmptyString(record.code_verifier, 'code_verifier');
  return {
    status: 'authorized',
    tokens: await exchangeDeviceApprovalForTokens({
      http: params.http,
      now: params.now,
      ...(params.signal ? { signal: params.signal } : {}),
      authorizationCode,
      codeVerifier,
    }),
  };
}

export async function authenticateCodexDevice(params: Readonly<{
  http: Pick<HttpService, 'request'>;
  now: () => number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  onUserCode?: (params: { verificationUrl: string; userCode: string }) => void;
}>): Promise<CodexAuthTokens> {
  const sleep = params.sleep ?? sdkSleep;
  const authorization = await beginCodexDeviceAuthorization({
    http: params.http,
    now: params.now(),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  params.onUserCode?.({
    verificationUrl: authorization.verificationUrl,
    userCode: authorization.userCode,
  });
  while (true) {
    const result = await pollCodexDeviceAuthorization({
      http: params.http,
      now: params.now(),
      ...(params.signal ? { signal: params.signal } : {}),
      deviceAuthId: authorization.deviceAuthId,
      userCode: authorization.userCode,
      pollIntervalMs: authorization.pollIntervalMs,
    });
    if (result.status === 'authorized') return result.tokens;
    await sleep(result.retryAfterMs);
  }
}
