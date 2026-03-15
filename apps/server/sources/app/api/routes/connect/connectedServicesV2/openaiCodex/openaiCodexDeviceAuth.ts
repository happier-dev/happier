import { randomBytes as nodeRandomBytes } from "node:crypto";

import {
  BOX_BUNDLE_PUBLIC_KEY_BYTES,
  decodeBase64,
  encodeBase64,
  sealBoxBundle,
  type ConnectedServiceId,
} from "@happier-dev/protocol";

import { assertNonEmptyString } from "../connectValueParsers";
import { extractOpenAiCodexAccountId } from "./openaiCodexIdTokenClaims";
import { resolveOpenAiCodexOauthClientId, resolveOpenAiCodexOauthTokenUrl } from "../oauthConfig";

const DEFAULT_OPENAI_ISSUER = "https://auth.openai.com";

export const OPENAI_CODEX_DEVICE_VERIFICATION_URL = `${DEFAULT_OPENAI_ISSUER}/codex/device`;
export const OPENAI_CODEX_DEVICE_REDIRECT_URI = `${DEFAULT_OPENAI_ISSUER}/deviceauth/callback`;

const OAUTH_POLLING_SAFETY_MARGIN_MS = 3_000;

type OauthExchangePayload = Readonly<{
  serviceId: ConnectedServiceId;
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  scope: string | null;
  tokenType: string | null;
  providerEmail: string | null;
  providerAccountId: string | null;
  expiresAt: number | null;
  raw: unknown;
}>;

function resolveOpenAiDeviceUsercodeUrl(): string {
  return `${DEFAULT_OPENAI_ISSUER}/api/accounts/deviceauth/usercode`;
}

function resolveOpenAiDeviceTokenUrl(): string {
  return `${DEFAULT_OPENAI_ISSUER}/api/accounts/deviceauth/token`;
}

function parseRecipientPublicKey(publicKeyB64Url: string): Uint8Array {
  const bytes = decodeBase64(publicKeyB64Url, "base64url");
  if (bytes.length !== BOX_BUNDLE_PUBLIC_KEY_BYTES) {
    throw new Error(`Invalid publicKey length: ${bytes.length}`);
  }
  return bytes;
}

export type OpenAiCodexDeviceAuthStartResult = Readonly<{
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
  verificationUrl: string;
}>;

export async function startOpenAiCodexDeviceAuth(params: Readonly<{ fetcher?: typeof fetch }>): Promise<OpenAiCodexDeviceAuthStartResult> {
  const fetcher = params.fetcher ?? fetch;
  const response = await fetcher(resolveOpenAiDeviceUsercodeUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: resolveOpenAiCodexOauthClientId(process.env) }),
  });
  if (!response.ok) {
    throw new Error(`Device auth start failed: ${response.status}`);
  }
  const json = (await response.json()) as any;
  const deviceAuthId = assertNonEmptyString(json?.device_auth_id, "device_auth_id");
  const userCode = assertNonEmptyString(json?.user_code, "user_code");
  const intervalSeconds = Math.max(Number.parseInt(String(json?.interval ?? "5"), 10) || 5, 1);
  return {
    deviceAuthId,
    userCode,
    intervalMs: intervalSeconds * 1000,
    verificationUrl: OPENAI_CODEX_DEVICE_VERIFICATION_URL,
  };
}

export type OpenAiCodexDeviceAuthPollResult =
  | Readonly<{ status: "pending"; retryAfterMs: number }>
  | Readonly<{ status: "approved"; authorizationCode: string; codeVerifier: string }>;

export async function pollOpenAiCodexDeviceAuthOnce(params: Readonly<{
  fetcher?: typeof fetch;
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
}>): Promise<OpenAiCodexDeviceAuthPollResult> {
  const fetcher = params.fetcher ?? fetch;
  const response = await fetcher(resolveOpenAiDeviceTokenUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      device_auth_id: params.deviceAuthId,
      user_code: params.userCode,
    }),
  });

  if (!response.ok) {
    if (response.status === 403 || response.status === 404) {
      return { status: "pending", retryAfterMs: Math.max(250, params.intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS) };
    }
    throw new Error(`Device auth poll failed: ${response.status}`);
  }

  const json = (await response.json()) as any;
  return {
    status: "approved",
    authorizationCode: assertNonEmptyString(json?.authorization_code, "authorization_code"),
    codeVerifier: assertNonEmptyString(json?.code_verifier, "code_verifier"),
  };
}

async function exchangeOpenAiCodexAuthorizationCodeForTokens(params: Readonly<{
  fetcher: typeof fetch;
  authorizationCode: string;
  codeVerifier: string;
  redirectUri: string;
  now: number;
}>): Promise<OauthExchangePayload> {
  const tokenUrl = resolveOpenAiCodexOauthTokenUrl(process.env);
  const clientId = resolveOpenAiCodexOauthClientId(process.env);

  const response = await params.fetcher(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code: params.authorizationCode,
      code_verifier: params.codeVerifier,
      redirect_uri: params.redirectUri,
    }),
  });
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status}`);
  }

  const json = (await response.json()) as any;
  const idToken = typeof json?.id_token === "string" ? json.id_token : null;
  const accessToken = typeof json?.access_token === "string" ? json.access_token : idToken;
  const refreshToken = assertNonEmptyString(json?.refresh_token, "refresh_token");
  const providerAccountId = extractOpenAiCodexAccountId(idToken);

  const expiresIn = Number.isFinite(json?.expires_in) ? Number(json.expires_in) : NaN;
  const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? params.now + Math.trunc(expiresIn) * 1000 : null;

  return {
    serviceId: "openai-codex",
    accessToken: assertNonEmptyString(accessToken, "access_token"),
    refreshToken,
    idToken,
    scope: null,
    tokenType: null,
    providerEmail: null,
    providerAccountId,
    expiresAt,
    raw: json,
  };
}

export async function exchangeOpenAiCodexDeviceAuthApprovalForBundle(params: Readonly<{
  fetcher?: typeof fetch;
  publicKeyB64Url: string;
  authorizationCode: string;
  codeVerifier: string;
  now: number;
  randomBytes?: (length: number) => Uint8Array;
}>): Promise<Readonly<{ bundleB64Url: string }>> {
  const fetcher = params.fetcher ?? fetch;
  const recipientPublicKey = parseRecipientPublicKey(params.publicKeyB64Url);
  const payload = await exchangeOpenAiCodexAuthorizationCodeForTokens({
    fetcher,
    authorizationCode: params.authorizationCode,
    codeVerifier: params.codeVerifier,
    redirectUri: OPENAI_CODEX_DEVICE_REDIRECT_URI,
    now: params.now,
  });

  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const bundle = sealBoxBundle({
    plaintext,
    recipientPublicKey,
    randomBytes: (length) => (params.randomBytes ? params.randomBytes(length) : nodeRandomBytes(length)),
  });

  return { bundleB64Url: encodeBase64(bundle, "base64url") };
}
