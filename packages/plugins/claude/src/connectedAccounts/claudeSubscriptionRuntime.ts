import { CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1 } from '@happier-dev/plugin-sdk/first-party/connected-accounts';
import {
  type ConnectedAccountAuthenticationContext as PluginConnectedAccountAuthenticationContext,
  type ConnectedAccountHealthResult as PluginConnectedAccountHealthResult,
  type ConnectedAccountRuntime as PluginConnectedAccountRuntime,
} from '@happier-dev/plugin-sdk/connected-accounts';
import { PluginError } from '@happier-dev/plugin-sdk';
import {
  CLAUDE_DEFAULT_SUBSCRIPTION_USAGE_URL,
  parseClaudeSubscriptionUsageMeters,
} from '../agent/auth/services/quota/subscriptionFetcher.js';
import {
  CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPES,
  CLAUDE_CODE_SETUP_TOKEN_SCOPES,
} from '../agent/auth/services/native/scopes.js';
import { CLAUDE_SUBSCRIPTION_OAUTH_PROFILE } from './claudeSubscriptionProfile.js';

const CLAUDE_CREDENTIAL_FILE_ID = '.credentials.json';
const SETUP_TOKEN_KEY = 'setupToken';
const ACCESS_TOKEN_KEY = 'accessToken';
const REFRESH_TOKEN_KEY = 'refreshToken';
const PROVIDER_ACCOUNT_ID_KEY = 'providerAccountId';
const PROVIDER_EMAIL_KEY = 'providerEmail';
const EXPIRES_AT_MS_KEY = 'expiresAtMs';
const SCOPES_KEY = 'scopes';
const ANTHROPIC_API_ORIGIN = 'https://api.anthropic.com';

type ClaudeTokens = Readonly<{
  accessToken: string;
  refreshToken: string;
  providerAccountId: string;
  providerEmail: string;
  expiresAtMs: number | null;
  scopes: readonly string[];
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

function parseResponseBody(body: Uint8Array): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseScopes(value: unknown): readonly string[] {
  const candidates = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,\s]+/u)
      : [];
  return [...new Set(candidates
    .filter((scope): scope is string => typeof scope === 'string')
    .map((scope) => scope.trim())
    .filter(Boolean))];
}

function readExpiresAtMs(value: unknown, now: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? now + Math.trunc(value * 1000)
    : null;
}

async function readCredential(
  credentials: ConnectedAccountCredentialReader,
  key: string,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<string> {
  return (await credentials.get(key, options))?.trim() ?? '';
}

async function writeOptionalCredential(
  store: CredentialStore,
  key: string,
  value: string,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<void> {
  if (value) {
    await store.set(key, value, options);
  } else {
    await store.delete(key, options);
  }
}

async function writeTokens(
  store: CredentialStore,
  tokens: ClaudeTokens,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<void> {
  await store.set(ACCESS_TOKEN_KEY, tokens.accessToken, options);
  await store.set(REFRESH_TOKEN_KEY, tokens.refreshToken, options);
  await writeOptionalCredential(store, PROVIDER_ACCOUNT_ID_KEY, tokens.providerAccountId, options);
  await writeOptionalCredential(store, PROVIDER_EMAIL_KEY, tokens.providerEmail, options);
  await store.set(SCOPES_KEY, JSON.stringify(tokens.scopes), options);
  if (tokens.expiresAtMs === null) {
    await store.delete(EXPIRES_AT_MS_KEY, options);
  } else {
    await store.set(EXPIRES_AT_MS_KEY, String(tokens.expiresAtMs), options);
  }
}

function connectedResult(tokens: ClaudeTokens) {
  const displayName = tokens.providerEmail || tokens.providerAccountId || 'Claude';
  return {
    status: 'connected' as const,
    ...(tokens.providerAccountId ? { accountId: tokens.providerAccountId } : {}),
    ...((tokens.providerAccountId || tokens.providerEmail)
      ? {
          providerIdentity: {
            ...(tokens.providerAccountId ? { accountId: tokens.providerAccountId } : {}),
            ...(tokens.providerEmail ? { email: tokens.providerEmail } : {}),
          },
        }
      : {}),
    displayName,
    scopes: tokens.scopes,
  };
}

async function exchangeTokens(
  params: Readonly<{
    body: Readonly<Record<string, string>>;
    fallbackRefreshToken?: string;
    fallbackProviderAccountId?: string;
    fallbackProviderEmail?: string;
    fallbackScopes?: readonly string[];
  }>,
  context: Pick<PluginConnectedAccountAuthenticationContext, 'services' | 'signal'>,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<
  | Readonly<{ status: 'success'; tokens: ClaudeTokens }>
  | Readonly<{ status: 'rejected'; diagnostic: ReturnType<typeof diagnostic> }>
  | Readonly<{ status: 'outcomeUnknown'; diagnostic: ReturnType<typeof diagnostic> }>
> {
  const signal = options?.signal ?? context.signal;
  let response: Awaited<ReturnType<typeof context.services.http.request>>;
  try {
    response = await context.services.http.request({
      url: CLAUDE_SUBSCRIPTION_OAUTH_PROFILE.tokenUrl,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify(params.body)),
      redirect: 'error',
    }, { signal });
  } catch (error) {
    if (signal.aborted) throw error;
    return {
      status: 'outcomeUnknown',
      diagnostic: diagnostic(
        'claude_subscription_oauth_outcome_unknown',
        'Claude did not return a conclusive OAuth result.',
      ),
    };
  }
  if (response.status >= 400 && response.status < 500) {
    return {
      status: 'rejected',
      diagnostic: diagnostic(
        'claude_subscription_oauth_rejected',
        'Claude rejected the OAuth request.',
      ),
    };
  }
  if (response.status < 200 || response.status >= 300) {
    return {
      status: 'outcomeUnknown',
      diagnostic: diagnostic(
        'claude_subscription_oauth_outcome_unknown',
        'Claude did not return a conclusive OAuth result.',
      ),
    };
  }
  const body = parseResponseBody(response.body);
  const account = isRecord(body?.account) ? body.account : null;
  const accessToken = readString(body?.access_token);
  const refreshToken = readString(body?.refresh_token) || params.fallbackRefreshToken || '';
  const providerAccountId = readString(account?.uuid) || params.fallbackProviderAccountId || '';
  const providerEmail = readString(account?.email_address) || params.fallbackProviderEmail || '';
  const scopes = parseScopes(body?.scope);
  if (!accessToken || !refreshToken) {
    return {
      status: 'outcomeUnknown',
      diagnostic: diagnostic(
        'claude_subscription_oauth_response_invalid',
        'Claude returned an incomplete OAuth result.',
      ),
    };
  }
  return {
    status: 'success',
    tokens: {
      accessToken,
      refreshToken,
      providerAccountId,
      providerEmail,
      expiresAtMs: readExpiresAtMs(body?.expires_in, Date.now()),
      scopes: scopes.length > 0 ? scopes : params.fallbackScopes ?? [],
    },
  };
}

async function readScopes(
  credentials: ConnectedAccountCredentialReader,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<readonly string[]> {
  const raw = await readCredential(credentials, SCOPES_KEY, options);
  if (!raw) return [];
  try {
    return parseScopes(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

function modeId(context: Parameters<PluginConnectedAccountRuntime['status']>[0]): string {
  return context.configuration.target.modeId;
}

async function readHealth(
  authenticationModeId: string,
  credentials: ConnectedAccountCredentialReader,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<PluginConnectedAccountHealthResult> {
  if (
    authenticationModeId
    === CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1.setupToken.authenticationModeId
  ) {
    return await readCredential(credentials, SETUP_TOKEN_KEY, options)
      ? { status: 'connected', displayName: 'Claude setup token', scopes: CLAUDE_CODE_SETUP_TOKEN_SCOPES }
      : {
          status: 'unavailable',
          diagnostic: diagnostic(
            'claude_subscription_setup_token_unavailable',
            'The Claude setup token is unavailable; reconnect the account.',
          ),
        };
  }
  if (
    authenticationModeId
    !== CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1.oauth.authenticationModeId
  ) {
    return {
      status: 'unavailable',
      diagnostic: diagnostic(
        'claude_subscription_authentication_mode_invalid',
        'The Claude authentication mode is unavailable.',
      ),
    };
  }
  const accessToken = await readCredential(credentials, ACCESS_TOKEN_KEY, options);
  if (!accessToken) {
    return {
      status: 'unavailable',
      diagnostic: diagnostic(
        'claude_subscription_credentials_unavailable',
        'Claude OAuth credentials are unavailable; reconnect the account.',
      ),
    };
  }
  const expiresAt = Number(await readCredential(credentials, EXPIRES_AT_MS_KEY, options));
  const scopes = await readScopes(credentials, options);
  const providerEmail = await readCredential(credentials, PROVIDER_EMAIL_KEY, options);
  if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= Date.now()) {
    return {
      status: 'expired',
      displayName: providerEmail || 'Claude',
      scopes,
      diagnostic: diagnostic(
        'claude_subscription_access_token_expired',
        'The Claude access token has expired.',
      ),
    };
  }
  return {
    status: 'connected',
    displayName: providerEmail || 'Claude',
    scopes,
  };
}

const claudeSubscriptionRuntimeDefinition: PluginConnectedAccountRuntime = {
  authentication: {
    modes: {
      [CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1.setupToken.authenticationModeId]: {
        kind: 'manual',
        async complete(input, context, options) {
          const setupToken = input.fields.token?.trim() ?? '';
          if (!setupToken) {
            return {
              status: 'rejected',
              diagnostic: diagnostic(
                'claude_subscription_setup_token_invalid',
                'Claude requires a non-empty setup token.',
              ),
            };
          }
          await context.attemptCredentials.set(SETUP_TOKEN_KEY, setupToken, options);
          return {
            status: 'connected',
            ...(context.attempt.kind === 'reconnect'
              ? { accountId: context.attempt.account.accountId }
              : {}),
            displayName: 'Claude setup token',
            scopes: CLAUDE_CODE_SETUP_TOKEN_SCOPES,
          };
        },
      },
      [CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1.oauth.authenticationModeId]: {
        kind: 'oauthAuthorizationCode',
        async begin(input) {
          const query = new URLSearchParams({
            response_type: 'code',
            client_id: CLAUDE_SUBSCRIPTION_OAUTH_PROFILE.clientId,
            redirect_uri: input.callbackUrl,
            scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPES.join(' '),
            code_challenge: input.pkce.challenge,
            code_challenge_method: input.pkce.method,
            state: input.state,
            code: 'true',
          });
          return {
            status: 'awaitingOAuthRedirect',
            authorizationUrl:
              `${CLAUDE_SUBSCRIPTION_OAUTH_PROFILE.authorizeUrl}?${query.toString()}`,
          };
        },
        async complete(input, context, options) {
          const exchanged = await exchangeTokens({
            body: {
              grant_type: 'authorization_code',
              code: input.code,
              redirect_uri: input.callbackUrl,
              client_id: CLAUDE_SUBSCRIPTION_OAUTH_PROFILE.clientId,
              code_verifier: input.pkceVerifier,
              state: input.state,
            },
          }, context, options);
          if (exchanged.status !== 'success') return exchanged;
          await writeTokens(context.attemptCredentials, exchanged.tokens, options);
          return connectedResult(exchanged.tokens);
        },
        async cancel() {},
      },
    },
  },
  async refresh(context, options) {
    const authenticationModeId = modeId(context);
    if (
      authenticationModeId
      === CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1.setupToken.authenticationModeId
    ) {
      return readHealth(authenticationModeId, context.credentials, options);
    }
    const refreshToken = await readCredential(context.credentials, REFRESH_TOKEN_KEY, options);
    if (!refreshToken) {
      return {
        status: 'reconnectRequired',
        diagnostic: diagnostic(
          'claude_subscription_refresh_token_unavailable',
          'The Claude refresh token is unavailable; reconnect the account.',
        ),
      };
    }
    const exchanged = await exchangeTokens({
      body: {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLAUDE_SUBSCRIPTION_OAUTH_PROFILE.clientId,
      },
      fallbackRefreshToken: refreshToken,
      fallbackProviderAccountId: await readCredential(
        context.credentials,
        PROVIDER_ACCOUNT_ID_KEY,
        options,
      ),
      fallbackProviderEmail: await readCredential(
        context.credentials,
        PROVIDER_EMAIL_KEY,
        options,
      ),
      fallbackScopes: await readScopes(context.credentials, options),
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
      displayName: exchanged.tokens.providerEmail
        || exchanged.tokens.providerAccountId
        || 'Claude',
      scopes: exchanged.tokens.scopes,
    };
  },
  async revoke() {
    return { status: 'remoteUnsupported' };
  },
  async status(context, options) {
    return readHealth(modeId(context), context.credentials, options);
  },
  async quota(context, options) {
    const authenticationModeId = modeId(context);
    if (
      authenticationModeId
      === CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1.setupToken.authenticationModeId
    ) {
      return { observedAtMs: Date.now(), limits: [] };
    }
    if (
      authenticationModeId
      !== CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1.oauth.authenticationModeId
    ) {
      throw new Error('Claude connected-account authentication mode is unavailable');
    }
    const signal = options?.signal ?? context.signal;
    const accessToken = await readCredential(context.credentials, ACCESS_TOKEN_KEY, options);
    if (!accessToken) {
      throw new Error('Claude OAuth credentials are unavailable');
    }
    const response = await context.services.http.request({
      url: CLAUDE_DEFAULT_SUBSCRIPTION_USAGE_URL,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
      },
      redirect: 'error',
    }, { signal });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Claude subscription usage fetch failed (${response.status})`);
    }
    const limits = parseClaudeSubscriptionUsageMeters(
      parseResponseBody(response.body),
    ).map((meter) => {
      const used = typeof meter.used === 'number' && Number.isFinite(meter.used)
        ? meter.used
        : typeof meter.utilizationPct === 'number' && Number.isFinite(meter.utilizationPct)
          ? meter.utilizationPct
          : undefined;
      const remaining =
        typeof meter.limit === 'number'
        && Number.isFinite(meter.limit)
        && used !== undefined
          ? Math.max(0, meter.limit - used)
          : typeof meter.utilizationPct === 'number'
            && Number.isFinite(meter.utilizationPct)
            ? Math.max(0, 100 - meter.utilizationPct)
            : undefined;
      return {
        id: meter.meterId,
        ...(used === undefined ? {} : { used }),
        ...(remaining === undefined ? {} : { remaining }),
        ...(typeof meter.resetsAt === 'number' && Number.isFinite(meter.resetsAt)
          ? { resetsAtMs: meter.resetsAt }
          : {}),
      };
    });
    return { observedAtMs: Date.now(), limits };
  },
  async materialize(request, context, options) {
    const authenticationModeId = modeId(context);
    if (
      authenticationModeId
      === CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1.setupToken.authenticationModeId
    ) {
      if (request.kind === 'environment') {
        const environmentKey =
          CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1.setupToken.environmentKey;
        if (request.keys.length !== 1 || request.keys[0] !== environmentKey) {
          throw new PluginError({
            code: CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1
              .unsupportedEnvironmentRequestErrorCode,
            message: 'Claude setup-token accounts materialize only their declared environment key.',
          });
        }
        const setupToken = await readCredential(context.credentials, SETUP_TOKEN_KEY, options);
        if (!setupToken) throw new Error('Claude setup-token credentials are unavailable');
        return { kind: 'environment', env: { [environmentKey]: setupToken } };
      }
      if (request.kind !== 'files') {
        throw new Error('Claude setup-token accounts do not support HTTP-header materialization');
      }
      const setupToken = await readCredential(context.credentials, SETUP_TOKEN_KEY, options);
      if (!setupToken) throw new Error('Claude setup-token credentials are unavailable');
      const files: Record<string, Uint8Array> = {};
      if (!request.fileIds.includes(CLAUDE_CREDENTIAL_FILE_ID)) return { kind: 'files', files };
      files[CLAUDE_CREDENTIAL_FILE_ID] = new TextEncoder().encode(JSON.stringify({
        claudeAiOauth: {
          accessToken: setupToken,
          scopes: CLAUDE_CODE_SETUP_TOKEN_SCOPES,
        },
      }));
      return { kind: 'files', files };
    }
    if (
      authenticationModeId
      !== CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1.oauth.authenticationModeId
    ) {
      throw new Error('Claude connected-account authentication mode is unavailable');
    }
    if (request.kind === 'environment') {
      const environmentKey =
        CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1.setupToken.environmentKey;
      if (request.keys.length === 1 && request.keys[0] === environmentKey) {
        throw new PluginError({
          code: CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1.oauth
            .requestAuthRequiredErrorCode,
          message: 'Claude OAuth Connected Accounts require request-auth materialization.',
        });
      }
      throw new PluginError({
        code: CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1
          .unsupportedEnvironmentRequestErrorCode,
        message: 'Claude OAuth Connected Accounts do not support this environment request.',
      });
    }
    if (request.kind === 'httpHeaders') {
      if (
        request.origin !== ANTHROPIC_API_ORIGIN
        || request.headerNames.length !== 1
        || request.headerNames[0]?.toLowerCase() !== 'authorization'
      ) {
        throw new Error('Claude OAuth connected accounts cannot materialize credentials for this HTTP-header request');
      }
      const accessToken = await readCredential(context.credentials, ACCESS_TOKEN_KEY, options);
      if (!accessToken) throw new Error('Claude OAuth credentials are unavailable');
      return {
        kind: 'httpHeaders',
        headers: { authorization: `Bearer ${accessToken}` },
      };
    }
    if (request.kind !== 'files') {
      throw new Error('Claude OAuth accounts do not support HTTP-header materialization');
    }
    const files: Record<string, Uint8Array> = {};
    if (!request.fileIds.includes(CLAUDE_CREDENTIAL_FILE_ID)) return { kind: 'files', files };
    const accessToken = await readCredential(context.credentials, ACCESS_TOKEN_KEY, options);
    if (!accessToken) throw new Error('Claude OAuth credentials are unavailable');
    const expiresAt = Number(await readCredential(context.credentials, EXPIRES_AT_MS_KEY, options));
    const payload = {
      claudeAiOauth: {
        accessToken,
        ...(Number.isFinite(expiresAt) && expiresAt > 0 ? { expiresAt } : {}),
        scopes: await readScopes(context.credentials, options),
      },
    };
    files[CLAUDE_CREDENTIAL_FILE_ID] = new TextEncoder().encode(JSON.stringify(payload));
    return { kind: 'files', files };
  },
};

export const claudeSubscriptionConnectedAccountRuntime: PluginConnectedAccountRuntime = Object.freeze(
  claudeSubscriptionRuntimeDefinition,
);
