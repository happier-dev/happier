import {
  type ConnectedAccountAuthenticationContext as PluginConnectedAccountAuthenticationContext,
  type ConnectedAccountHealthResult as PluginConnectedAccountHealthResult,
  type ConnectedAccountRuntime as PluginConnectedAccountRuntime,
} from '@happier-dev/plugin-sdk/connected-accounts';
import { OPENAI_CODEX_OAUTH_PROFILE } from './openAiCodexProfile.js';

import { buildCodexCloudAuthFile } from '../agent/auth/services/openai/cloud/authFile.js';
import {
  buildCodexAuthorizationUrl,
  extractOpenAiAccountIdFromIdToken,
} from '../agent/auth/services/openai/cloud/oauth.js';
import {
  beginCodexDeviceAuthorization,
  pollCodexDeviceAuthorization,
} from '../agent/auth/services/openai/cloud/device.js';
import {
  OPENAI_CODEX_DEFAULT_USAGE_URL,
  parseOpenAiCodexConnectedAccountQuotaLimits,
} from '../agent/auth/services/quota/openaiFetcher.js';

const ACCESS_TOKEN_KEY = 'accessToken';
const REFRESH_TOKEN_KEY = 'refreshToken';
const ID_TOKEN_KEY = 'idToken';
const PROVIDER_ACCOUNT_ID_KEY = 'providerAccountId';
const EXPIRES_AT_MS_KEY = 'expiresAtMs';
const LAST_REFRESH_AT_MS_KEY = 'lastRefreshAtMs';
const DEVICE_AUTH_ID_KEY = 'deviceAuthId';
const DEVICE_USER_CODE_KEY = 'deviceUserCode';
const DEVICE_POLL_INTERVAL_MS_KEY = 'devicePollIntervalMs';
const CODEX_AUTH_FILE_ID = 'auth.json';
const OPENAI_CODEX_OAUTH_TOKEN_ENV_KEY = 'OPENAI_CODEX_OAUTH_TOKEN';
const OPENAI_API_ORIGIN = 'https://api.openai.com';
const CHATGPT_API_ORIGIN = 'https://chatgpt.com';
const CODEX_SCOPES = OPENAI_CODEX_OAUTH_PROFILE.scopes;

type CodexTokens = Readonly<{
  accessToken: string;
  refreshToken: string;
  idToken: string;
  providerAccountId: string;
  expiresAtMs: number | null;
}>;
type CredentialStore = PluginConnectedAccountAuthenticationContext['attemptCredentials'];
type ConnectedAccountCredentialReader =
  Parameters<PluginConnectedAccountRuntime['status']>[0]['credentials'];

function diagnostic(code: string, message: string) {
  return { code, severity: 'error' as const, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isExactOrigin(value: string, expected: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.origin === value && parsed.origin === expected;
  } catch {
    return false;
  }
}

function parseResponseBody(body: Uint8Array): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readExpiresAtMs(value: unknown, now: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? now + Math.trunc(value * 1000)
    : null;
}

async function writeTokens(
  store: CredentialStore,
  tokens: CodexTokens,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<void> {
  await store.set(ACCESS_TOKEN_KEY, tokens.accessToken, options);
  await store.set(REFRESH_TOKEN_KEY, tokens.refreshToken, options);
  await store.set(ID_TOKEN_KEY, tokens.idToken, options);
  await store.set(PROVIDER_ACCOUNT_ID_KEY, tokens.providerAccountId, options);
  if (tokens.expiresAtMs === null) {
    await store.delete(EXPIRES_AT_MS_KEY, options);
  } else {
    await store.set(EXPIRES_AT_MS_KEY, String(tokens.expiresAtMs), options);
  }
  await store.set(LAST_REFRESH_AT_MS_KEY, String(Date.now()), options);
}

async function readCredential(
  credentials: ConnectedAccountCredentialReader,
  key: string,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<string> {
  return (await credentials.get(key, options))?.trim() ?? '';
}

async function exchangeTokens(
  params: Readonly<{
    body: URLSearchParams;
    fallbackRefreshToken?: string;
    fallbackIdToken?: string;
    fallbackProviderAccountId?: string;
  }>,
  context: Pick<PluginConnectedAccountAuthenticationContext, 'services' | 'signal'>,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<
  | Readonly<{ status: 'success'; tokens: CodexTokens }>
  | Readonly<{ status: 'rejected' | 'unavailable' | 'outcomeUnknown'; diagnostic: ReturnType<typeof diagnostic> }>
> {
  const signal = options?.signal ?? context.signal;
  let response: Awaited<ReturnType<typeof context.services.http.request>>;
  try {
    response = await context.services.http.request({
      url: OPENAI_CODEX_OAUTH_PROFILE.tokenUrl,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new TextEncoder().encode(params.body.toString()),
      redirect: 'error',
    }, { signal });
  } catch (error) {
    if (signal.aborted) throw error;
    return {
      status: 'outcomeUnknown',
      diagnostic: diagnostic(
        'openai_codex_oauth_outcome_unknown',
        'OpenAI Codex did not return a conclusive OAuth result.',
      ),
    };
  }
  if (response.status >= 400 && response.status < 500) {
    return {
      status: 'rejected',
      diagnostic: diagnostic(
        'openai_codex_oauth_rejected',
        'OpenAI rejected the Codex OAuth request.',
      ),
    };
  }
  if (response.status < 200 || response.status >= 300) {
    return {
      status: 'outcomeUnknown',
      diagnostic: diagnostic(
        'openai_codex_oauth_outcome_unknown',
        'OpenAI Codex did not return a conclusive OAuth result.',
      ),
    };
  }
  const body = parseResponseBody(response.body);
  const idToken = readString(body?.id_token) || params.fallbackIdToken || '';
  const accessToken = readString(body?.access_token) || idToken;
  const refreshToken = readString(body?.refresh_token) || params.fallbackRefreshToken || '';
  let providerAccountId = params.fallbackProviderAccountId ?? '';
  try {
    providerAccountId = idToken
      ? extractOpenAiAccountIdFromIdToken(idToken) || providerAccountId
      : providerAccountId;
  } catch {
    providerAccountId = params.fallbackProviderAccountId ?? '';
  }
  if (!accessToken || !refreshToken || !idToken) {
    return {
      status: 'outcomeUnknown',
      diagnostic: diagnostic(
        'openai_codex_oauth_response_invalid',
        'OpenAI Codex returned an incomplete OAuth result.',
      ),
    };
  }
  return {
    status: 'success',
    tokens: {
      accessToken,
      refreshToken,
      idToken,
      providerAccountId,
      expiresAtMs: readExpiresAtMs(body?.expires_in, Date.now()),
    },
  };
}

function connectedResult(tokens: CodexTokens) {
  return {
    status: 'connected' as const,
    ...(tokens.providerAccountId
      ? {
          accountId: tokens.providerAccountId,
          providerIdentity: { accountId: tokens.providerAccountId },
        }
      : {}),
    displayName: tokens.providerAccountId || 'Codex',
    scopes: CODEX_SCOPES,
  };
}

async function readHealth(
  credentials: ConnectedAccountCredentialReader,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<PluginConnectedAccountHealthResult> {
  const accessToken = await readCredential(credentials, ACCESS_TOKEN_KEY, options);
  const expiresAt = Number(await readCredential(credentials, EXPIRES_AT_MS_KEY, options));
  if (!accessToken) {
    return {
      status: 'unavailable',
      diagnostic: diagnostic(
        'openai_codex_credentials_unavailable',
        'OpenAI Codex credentials are unavailable; reconnect the account.',
      ),
    };
  }
  if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= Date.now()) {
    return {
      status: 'expired',
      displayName: 'Codex',
      scopes: CODEX_SCOPES,
      diagnostic: diagnostic(
        'openai_codex_access_token_expired',
        'The OpenAI Codex access token has expired.',
      ),
    };
  }
  const providerAccountId = await readCredential(credentials, PROVIDER_ACCOUNT_ID_KEY, options);
  return {
    status: 'connected',
    displayName: providerAccountId || 'Codex',
    scopes: CODEX_SCOPES,
  };
}

async function readCurrentAccessToken(
  credentials: ConnectedAccountCredentialReader,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<string> {
  const accessToken = await readCredential(credentials, ACCESS_TOKEN_KEY, options);
  const expiresAt = Number(await readCredential(credentials, EXPIRES_AT_MS_KEY, options));
  if (
    !accessToken
    || (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= Date.now())
  ) {
    throw new Error('OpenAI Codex connected-account credentials are unavailable');
  }
  return accessToken;
}

const openAiCodexRuntimeDefinition: PluginConnectedAccountRuntime = {
  authentication: {
    modes: {
      oauth: {
        kind: 'oauthAuthorizationCode',
        async begin(input) {
          return {
            status: 'awaitingOAuthRedirect',
            authorizationUrl: buildCodexAuthorizationUrl({
              redirectUri: input.callbackUrl,
              state: input.state,
              challenge: input.pkce.challenge,
            }),
          };
        },
        async complete(input, context, options) {
          const exchanged = await exchangeTokens({
            body: new URLSearchParams({
              grant_type: 'authorization_code',
              client_id: OPENAI_CODEX_OAUTH_PROFILE.clientId,
              code: input.code,
              code_verifier: input.pkceVerifier,
              redirect_uri: input.callbackUrl,
            }),
          }, context, options);
          if (exchanged.status !== 'success') return exchanged;
          await writeTokens(context.attemptCredentials, exchanged.tokens, options);
          return connectedResult(exchanged.tokens);
        },
        async cancel() {},
      },
      device: {
        kind: 'oauthDeviceCode',
        async begin(context, options) {
          const signal = options?.signal ?? context.signal;
          const authorization = await beginCodexDeviceAuthorization({
            http: context.services.http,
            now: Date.now(),
            signal,
          });
          await context.attemptCredentials.set(
            DEVICE_AUTH_ID_KEY,
            authorization.deviceAuthId,
            options,
          );
          await context.attemptCredentials.set(
            DEVICE_USER_CODE_KEY,
            authorization.userCode,
            options,
          );
          await context.attemptCredentials.set(
            DEVICE_POLL_INTERVAL_MS_KEY,
            String(authorization.pollIntervalMs),
            options,
          );
          return {
            status: 'awaitingDeviceAuthorization',
            verificationUri: authorization.verificationUrl,
            userCode: authorization.userCode,
            expiresAtMs: authorization.expiresAtMs,
            pollIntervalMs: authorization.pollIntervalMs,
          };
        },
        async poll(context, options) {
          const deviceAuthId = await readCredential(
            context.attemptCredentials,
            DEVICE_AUTH_ID_KEY,
            options,
          );
          const userCode = await readCredential(
            context.attemptCredentials,
            DEVICE_USER_CODE_KEY,
            options,
          );
          const pollIntervalMs = Number(await readCredential(
            context.attemptCredentials,
            DEVICE_POLL_INTERVAL_MS_KEY,
            options,
          ));
          if (!deviceAuthId || !userCode || !Number.isFinite(pollIntervalMs)) {
            return {
              status: 'unavailable',
              diagnostic: diagnostic(
                'openai_codex_device_transaction_unavailable',
                'The OpenAI Codex device authorization attempt is unavailable.',
              ),
            };
          }
          const result = await pollCodexDeviceAuthorization({
            http: context.services.http,
            now: Date.now(),
            signal: options?.signal ?? context.signal,
            deviceAuthId,
            userCode,
            pollIntervalMs,
          });
          if (result.status === 'pending') return result;
          const tokens: CodexTokens = {
            accessToken: result.tokens.access_token,
            refreshToken: result.tokens.refresh_token,
            idToken: result.tokens.id_token,
            providerAccountId: result.tokens.account_id,
            expiresAtMs: result.tokens.expires_at ?? null,
          };
          await writeTokens(context.attemptCredentials, tokens, options);
          return connectedResult(tokens);
        },
        async cancel() {},
      },
    },
  },
  async refresh(context, options) {
    const refreshToken = await readCredential(context.credentials, REFRESH_TOKEN_KEY, options);
    if (!refreshToken) {
      return {
        status: 'reconnectRequired',
        diagnostic: diagnostic(
          'openai_codex_refresh_token_unavailable',
          'The OpenAI Codex refresh token is unavailable; reconnect the account.',
        ),
      };
    }
    const idToken = await readCredential(context.credentials, ID_TOKEN_KEY, options);
    const providerAccountId = await readCredential(
      context.credentials,
      PROVIDER_ACCOUNT_ID_KEY,
      options,
    );
    const exchanged = await exchangeTokens({
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: OPENAI_CODEX_OAUTH_PROFILE.clientId,
        refresh_token: refreshToken,
      }),
      fallbackRefreshToken: refreshToken,
      fallbackIdToken: idToken,
      fallbackProviderAccountId: providerAccountId,
    }, context, options);
    if (exchanged.status === 'rejected') {
      return {
        status: 'reconnectRequired',
        diagnostic: exchanged.diagnostic,
      };
    }
    if (exchanged.status !== 'success') return exchanged;
    await writeTokens(context.stagedCredentials, exchanged.tokens, options);
    return {
      status: 'connected',
      displayName: exchanged.tokens.providerAccountId,
      scopes: CODEX_SCOPES,
    };
  },
  async revoke() {
    return { status: 'remoteUnsupported' };
  },
  async status(context, options) {
    return readHealth(context.credentials, options);
  },
  async quota(context, options) {
    const signal = options?.signal ?? context.signal;
    const accessToken = await readCredential(context.credentials, ACCESS_TOKEN_KEY, options);
    if (!accessToken) {
      throw new Error('OpenAI Codex connected-account credentials are unavailable');
    }
    const providerAccountId = await readCredential(
      context.credentials,
      PROVIDER_ACCOUNT_ID_KEY,
      options,
    );
    const response = await context.services.http.request({
      url: OPENAI_CODEX_DEFAULT_USAGE_URL,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(providerAccountId
          ? { 'ChatGPT-Account-Id': providerAccountId }
          : {}),
        Accept: 'application/json',
      },
      redirect: 'error',
    }, { signal });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`OpenAI Codex usage fetch failed (${response.status})`);
    }
    return {
      observedAtMs: Date.now(),
      limits: parseOpenAiCodexConnectedAccountQuotaLimits(
        parseResponseBody(response.body),
      ),
    };
  },
  async materialize(request, context, options) {
    if (request.kind === 'environment') {
      const env: Record<string, string> = {};
      if (request.keys.includes(OPENAI_CODEX_OAUTH_TOKEN_ENV_KEY)) {
        env[OPENAI_CODEX_OAUTH_TOKEN_ENV_KEY] = await readCurrentAccessToken(
          context.credentials,
          options,
        );
      }
      return { kind: 'environment', env };
    }
    if (request.kind === 'httpHeaders') {
      if (
        !isExactOrigin(request.origin, OPENAI_API_ORIGIN)
        && !isExactOrigin(request.origin, CHATGPT_API_ORIGIN)
      ) {
        throw new Error('OpenAI Codex connected accounts cannot materialize credentials for this origin');
      }
      const accessToken = await readCurrentAccessToken(context.credentials, options);
      const requestedNames = new Set(
        request.headerNames.map((name) => name.toLowerCase()),
      );
      if (
        requestedNames.size !== request.headerNames.length
        || !requestedNames.has('authorization')
        || [...requestedNames].some((name) =>
          name !== 'authorization' && name !== 'chatgpt-account-id')
      ) {
        throw new Error('OpenAI Codex connected accounts received an unsupported HTTP-header request');
      }
      const headers: Record<string, string> = {};
      if (requestedNames.has('authorization')) {
        headers.Authorization = `Bearer ${accessToken}`;
      }
      if (requestedNames.has('chatgpt-account-id')) {
        const providerAccountId = await readCredential(
          context.credentials,
          PROVIDER_ACCOUNT_ID_KEY,
          options,
        );
        if (providerAccountId) {
          headers['ChatGPT-Account-Id'] = providerAccountId;
        }
      }
      return { kind: 'httpHeaders', headers };
    }
    if (request.kind !== 'files') {
      throw new Error('OpenAI Codex connected accounts support native credential-file materialization only');
    }
    const files: Record<string, Uint8Array> = {};
    if (!request.fileIds.includes(CODEX_AUTH_FILE_ID)) return { kind: 'files', files };
    const accessToken = await readCredential(context.credentials, ACCESS_TOKEN_KEY, options);
    const refreshToken = await readCredential(context.credentials, REFRESH_TOKEN_KEY, options);
    const idToken = await readCredential(context.credentials, ID_TOKEN_KEY, options);
    const providerAccountId = await readCredential(
      context.credentials,
      PROVIDER_ACCOUNT_ID_KEY,
      options,
    );
    if (!accessToken || !refreshToken || !idToken) {
      throw new Error('OpenAI Codex connected-account credentials are unavailable');
    }
    const lastRefreshAt = Number(
      await readCredential(context.credentials, LAST_REFRESH_AT_MS_KEY, options),
    );
    const lastRefreshIso = new Date(
      Number.isFinite(lastRefreshAt) && lastRefreshAt > 0 ? lastRefreshAt : 0,
    ).toISOString();
    files[CODEX_AUTH_FILE_ID] = new TextEncoder().encode(JSON.stringify(
      buildCodexCloudAuthFile({
        accessToken,
        refreshToken,
        idToken,
        accountId: providerAccountId || null,
        lastRefreshIso,
      }),
    ));
    return { kind: 'files', files };
  },
};

export const openAiCodexConnectedAccountRuntime: PluginConnectedAccountRuntime = Object.freeze(
  openAiCodexRuntimeDefinition,
);
