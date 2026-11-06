import { reconcileClaudeNativeAccountConfig } from '../agent/auth/services/native/accountIdentity.js';
import { normalizeClaudeOauthProfileEntitlement, type ClaudeOauthCredentialMetadata } from '@happier-dev/plugin-sdk/first-party/claude';
import { CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1 } from '@happier-dev/plugin-sdk/first-party/connected-accounts';
import {
  type ConnectedAccountAuthenticationContext as PluginConnectedAccountAuthenticationContext,
  type ConnectedAccountMaterialization,
  type ConnectedAccountHealthResult as PluginConnectedAccountHealthResult,
  type ConnectedAccountRuntime as PluginConnectedAccountRuntime,
  type ConnectedAccountAuthenticationModeRuntime,
} from '@happier-dev/plugin-sdk/connected-accounts';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';
import { resolveClaudeCodeUsageUserAgent } from '../agent/auth/services/quota/userAgent.js';
import {
  createClaudeSubscriptionHttpClient,
  parseClaudeSubscriptionConnectedAccountQuotaLimits,
  resolveClaudeSubscriptionPlanLabelFromMetadata,
} from '../agent/auth/services/quota/subscriptionFetcher.js';
import {
  CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPES,
  CLAUDE_CODE_SETUP_TOKEN_SCOPES,
  findMissingClaudeCodeCredentialScopes,
} from '../agent/auth/services/native/scopes.js';
import type { readClaudeCodeNativeCredential } from '../agent/auth/services/native/readCredential.js';
import { CLAUDE_SUBSCRIPTION_OAUTH_PROFILE } from './claudeSubscriptionProfile.js';

type QuotaContext = Parameters<NonNullable<PluginConnectedAccountRuntime['quota']>>[0];
async function createRuntimeQuotaClient(context: QuotaContext, signal: AbortSignal) {
  let installedVersion: string | undefined;
  try {
    const readiness = await context.services.exec.agentCli.checkReadiness({
      candidates: ['claude'], requirement: 'any', includeVersion: true, signal,
    });
    installedVersion = readiness.launchable.find(candidate => candidate.agentId === 'claude')?.version;
  } catch (error) {
    signal.throwIfAborted();
    if (!isPluginError(error)) throw error;
    const versionUnavailable = [
      'plugin_exec_agent_cli_version_unavailable',
      'plugin_exec_agent_cli_version_failed',
      'plugin_exec_system_tool_denied',
      'plugin_exec_system_tool_unavailable',
      'plugin_exec_argument_denied',
    ].includes(error.code);
    const execUnavailable = [
      'plugin_host_access_resource_not_selected',
      'plugin_service_unavailable',
      'plugin_host_access_declaration_missing',
    ].includes(error.code) && isRecord(error.details) && error.details.serviceId === 'exec';
    if (!versionUnavailable && !execUnavailable) throw error;
    context.services.logger.warn('Claude CLI version is unavailable; ordinary usage remains available.', { code: error.code });
  }
  return createRuntimeHttpClient(context, installedVersion);
}

function createRuntimeHttpClient(
  context: Pick<PluginConnectedAccountAuthenticationContext, 'services' | 'signal'>,
  installedVersion?: string,
) {
  return createClaudeSubscriptionHttpClient({ userAgent: resolveClaudeCodeUsageUserAgent({ installedVersion }), runtimeFetch: async ({ url, method, headers, body, signal }) => {
    const response = await context.services.http.request({ url, method: method ?? 'GET', headers,
      ...(body === undefined ? {} : { body: new TextEncoder().encode(JSON.stringify(body)) }), redirect: 'error' }, { signal });
    const text = new TextDecoder().decode(response.body);
    return { ok: response.status >= 200 && response.status < 300, status: response.status,
      headers: response.headers, text: async () => text, json: async () => JSON.parse(text) as unknown,
      arrayBuffer: async () => Uint8Array.from(response.body).buffer };
  } });
}

export const CLAUDE_NATIVE_IMPORT_MODE_ID = 'native-import';

const CLAUDE_CREDENTIAL_FILE_ID = '.credentials.json';
const SETUP_TOKEN_KEY = 'setupToken';
const ACCESS_TOKEN_KEY = 'accessToken';
const REFRESH_TOKEN_KEY = 'refreshToken';
const PROVIDER_ACCOUNT_ID_KEY = 'providerAccountId';
const PROVIDER_EMAIL_KEY = 'providerEmail';
const EXPIRES_AT_MS_KEY = 'expiresAtMs';
const SCOPES_KEY = 'scopes';
const SUBSCRIPTION_TYPE_KEY = 'subscriptionType';

function classifyUsageAccountScope(subscriptionType: unknown): ConnectedAccountMaterialization['usageAccountScope'] {
  switch (subscriptionType) {
    case 'pro': case 'max': return 'personal';
    case 'team': case 'enterprise': return 'workspace';
    default: return 'unknown';
  }
}
const RATE_LIMIT_TIER_KEY = 'rateLimitTier';
const ORGANIZATION_UUID_KEY = 'organizationUuid';
const ANTHROPIC_API_ORIGIN = 'https://api.anthropic.com';

type ClaudeTokens = Readonly<{
  accessToken: string;
  refreshToken: string;
  providerAccountId: string;
  providerEmail: string;
  expiresAtMs: number | null;
  scopes: readonly string[];
  metadata?: ClaudeOauthCredentialMetadata;
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

async function readPlanMetadata(credentials: ConnectedAccountCredentialReader, options?: Readonly<{ signal?: AbortSignal }>) {
  const [subscriptionType, rateLimitTier] = await Promise.all([
    readCredential(credentials, SUBSCRIPTION_TYPE_KEY, options),
    readCredential(credentials, RATE_LIMIT_TIER_KEY, options),
  ]);
  return {
    ...(subscriptionType ? { subscriptionType } : {}),
    ...(rateLimitTier ? { rateLimitTier } : {}),
  };
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

async function writeMetadata(store: CredentialStore, metadata: ClaudeOauthCredentialMetadata,
  options?: Readonly<{ signal?: AbortSignal }>): Promise<void> {
  await writeOptionalCredential(store, SUBSCRIPTION_TYPE_KEY, metadata.subscriptionType ?? '', options);
  await writeOptionalCredential(store, RATE_LIMIT_TIER_KEY, metadata.rateLimitTier ?? '', options);
  await writeOptionalCredential(store, ORGANIZATION_UUID_KEY, metadata.organizationUuid ?? '', options);
}

async function writeTokens(
  store: CredentialStore,
  tokens: ClaudeTokens,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<void> {
  await writeMetadata(store, tokens.metadata ?? {}, options);
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

function connectedResult(tokens: Pick<ClaudeTokens, 'providerAccountId' | 'providerEmail' | 'scopes' | 'metadata'>) {
  const displayName = tokens.providerEmail || tokens.providerAccountId || 'Claude';
  return {
    status: 'connected' as const,
    providerIdentity: {
      accountId: tokens.providerAccountId || null,
      ...(tokens.providerEmail ? { email: tokens.providerEmail } : tokens.providerAccountId ? {} : { email: null }),
      organizationId: tokens.metadata?.organizationUuid ?? null,
    },
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
  if (response.status >= 400 && response.status < 500 && response.status !== 429) {
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
  const responseProviderAccountId = readString(account?.uuid);
  if (params.fallbackProviderAccountId && responseProviderAccountId
    && responseProviderAccountId !== params.fallbackProviderAccountId) {
    return { status: 'outcomeUnknown', diagnostic: diagnostic('claude_subscription_oauth_identity_mismatch',
      'Claude returned a different account for the existing credential.') };
  }
  const providerAccountId = responseProviderAccountId || params.fallbackProviderAccountId || '';
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
  let metadata = normalizeClaudeOauthProfileEntitlement(body)?.claudeAiOauth ?? {};
  let attestedProviderAccountId = providerAccountId;
  let attestedProviderEmail = providerEmail;
  if (!metadata.organizationUuid || !providerAccountId) {
    try {
      const profile = await createRuntimeHttpClient(context).readProfileContext({
        accessToken, expectedProviderAccountId: providerAccountId || null, now: Date.now(), signal,
      });
      if (profile.status === 'identityMismatch') return {
        status: 'outcomeUnknown', diagnostic: diagnostic('claude_subscription_profile_identity_mismatch',
          'Claude profile did not match the credential account.'),
      };
      if (profile.status === 'accepted') {
        metadata = { ...metadata, ...profile.metadata };
        attestedProviderAccountId = profile.providerAccountId || providerAccountId;
        attestedProviderEmail = profile.providerEmail || providerEmail;
      }
    } catch (error) {
      signal.throwIfAborted();
      context.services.logger?.warn('Claude credential context could not be attested.', { code: 'claude_subscription_profile_unavailable' });
    }
  }
  return {
    status: 'success',
    tokens: {
      accessToken,
      refreshToken,
      providerAccountId: attestedProviderAccountId,
      providerEmail: attestedProviderEmail,
      metadata,
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

function usesClaudeOAuthCredentials(authenticationModeId: string): boolean {
  // Acquisition provenance differs; both modes stage the same OAuth credential shape.
  return authenticationModeId === CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1.oauth.authenticationModeId
    || authenticationModeId === CLAUDE_NATIVE_IMPORT_MODE_ID;
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
  if (!usesClaudeOAuthCredentials(authenticationModeId)) {
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

export function createClaudeSubscriptionConnectedAccountRuntime(
  readNativeCredential?: typeof readClaudeCodeNativeCredential,
): PluginConnectedAccountRuntime {
  const nativeImportMode: Extract<ConnectedAccountAuthenticationModeRuntime, { kind: 'manual' }> | undefined = readNativeCredential ? {

        kind: 'manual',
        async complete(input, context, options) {
          const signal = options?.signal ?? context.signal;
          signal.throwIfAborted();
          if (input.fields.source !== 'native') {
            return { status: 'rejected', diagnostic: diagnostic(
              'claude_subscription_native_source_unsupported', 'This Claude native login source is not supported.',
            ) };
          }
          const native = await readNativeCredential({ signal });
          signal.throwIfAborted();
          if (!native) {
            return { status: 'unavailable', diagnostic: diagnostic(
              'claude_subscription_native_credentials_unavailable', 'No supported Claude native login was found on this machine.',
            ) };
          }
          const credential = native.claudeAiOauth;
          if (!credential.refreshToken || typeof credential.expiresAt !== 'number'
            || credential.expiresAt <= Date.now() || findMissingClaudeCodeCredentialScopes(credential.scopes).length > 0) {
            return { status: 'rejected', diagnostic: diagnostic(
              'claude_subscription_native_reauthorization_required', 'Sign in to Claude again before importing this native login.',
            ) };
          }
          // Copy a valid native grant without rotating it. Separate root-config identity cannot
          // prove this credential's account; the host owns account identity when it is unknown.
          const tokens: ClaudeTokens = {
            accessToken: credential.accessToken, refreshToken: credential.refreshToken,
            expiresAtMs: credential.expiresAt, scopes: credential.scopes,
            providerAccountId: '', providerEmail: '',
          };
          const operationOptions = { signal };
          await writeTokens(context.attemptCredentials, tokens, operationOptions);
          await writeOptionalCredential(context.attemptCredentials, SUBSCRIPTION_TYPE_KEY, credential.subscriptionType ?? '', operationOptions);
          await writeOptionalCredential(context.attemptCredentials, RATE_LIMIT_TIER_KEY, credential.rateLimitTier ?? '', operationOptions);
          return connectedResult(tokens);
        },
      } : undefined;
  const claudeSubscriptionRuntimeDefinition: PluginConnectedAccountRuntime = {
  authentication: {
    modes: {
      ...(nativeImportMode ? { [CLAUDE_NATIVE_IMPORT_MODE_ID]: nativeImportMode } : {}),
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
            providerIdentity: { accountId: null, email: null, organizationId: null },
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
    if (!usesClaudeOAuthCredentials(authenticationModeId)) {
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
    return connectedResult(exchanged.tokens);
  },
  async enrichCredentialContext(context, options) {
    if (!usesClaudeOAuthCredentials(modeId(context))) return readHealth(modeId(context), context.credentials, options);
    const signal = options?.signal ?? context.signal;
    const accessToken = await readCredential(context.credentials, ACCESS_TOKEN_KEY, options);
    const expected = await readCredential(context.credentials, PROVIDER_ACCOUNT_ID_KEY, options);
    try {
      const profile = await createRuntimeHttpClient(context).readProfileContext({
        accessToken, expectedProviderAccountId: expected || null, now: Date.now(), signal,
      });
      if (profile.status === 'accepted' && profile.providerAccountId && profile.metadata.organizationUuid) {
        await writeMetadata(context.stagedCredentials, profile.metadata, options);
        await writeOptionalCredential(context.stagedCredentials, PROVIDER_ACCOUNT_ID_KEY, profile.providerAccountId, options);
        await writeOptionalCredential(context.stagedCredentials, PROVIDER_EMAIL_KEY, profile.providerEmail, options);
        return connectedResult({ providerAccountId: profile.providerAccountId, providerEmail: profile.providerEmail,
          scopes: await readScopes(context.credentials, options), metadata: profile.metadata });
      }
    } catch (error) {
      signal.throwIfAborted();
    }
    return { status: 'outcomeUnknown', diagnostic: diagnostic('claude_subscription_profile_context_unavailable',
      'Claude credential context could not be attested.') };
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
    if (!usesClaudeOAuthCredentials(authenticationModeId)) {
      throw new Error('Claude connected-account authentication mode is unavailable');
    }
    const signal = options?.signal ?? context.signal;
    const accessToken = await readCredential(context.credentials, ACCESS_TOKEN_KEY, options);
    if (!accessToken) {
      throw new Error('Claude OAuth credentials are unavailable');
    }
    const payload = await (await createRuntimeQuotaClient(context, signal)).readUsage({ accessToken, now: Date.now(), signal });
    const limits = parseClaudeSubscriptionConnectedAccountQuotaLimits(payload);
    const planLabel = resolveClaudeSubscriptionPlanLabelFromMetadata(await readPlanMetadata(context.credentials, options));
    const providerOrganizationId = await readCredential(context.credentials, ORGANIZATION_UUID_KEY, options);
    return { observedAtMs: Date.now(), limits, ...(planLabel ? { planLabel } : {}),
      ...(providerOrganizationId ? { providerOrganizationId } : {}) };
  },
  recoveryCredits: {
    async read(context, options) {
      const observedAtMs = Date.now();
      if (!usesClaudeOAuthCredentials(modeId(context))) {
        return { observedAtMs, availableCount: 0, credits: [] };
      }
      const accessToken = await readCredential(context.credentials, ACCESS_TOKEN_KEY, options);
      if (!accessToken) throw new Error('Claude OAuth credentials are unavailable');
      const { inventory } = await (await createRuntimeQuotaClient(context, options?.signal ?? context.signal)).readResets({ accessToken, now: observedAtMs,
        signal: options?.signal ?? context.signal });
      if (!inventory) {
        throw new PluginError({
          code: 'plugin_connected_account_claude_reset_inventory_unavailable',
          message: 'Claude reset eligibility was not evaluated.',
        });
      }
      return { observedAtMs, availableCount: inventory.recoveryCredits.availableCount,
        credits: inventory.recoveryCredits.credits.flatMap(({ id, ...credit }) => id
          ? [{ ...credit, providerCreditId: id }] : []),
        recoveryCreditDetails: inventory.recoveryCreditDetails };
    },
    async consume(request, context, options) {
      if (!usesClaudeOAuthCredentials(modeId(context))) {
        return { status: 'not_available' };
      }
      const accessToken = await readCredential(context.credentials, ACCESS_TOKEN_KEY, options);
      if (!accessToken) throw new Error('Claude OAuth credentials are unavailable');
      const scopes = await readScopes(context.credentials, options);
      if (!scopes.includes('user:inference') || !scopes.includes('user:sessions:claude_code')) return { status: 'not_available' };
      const status = await (await createRuntimeQuotaClient(context, options?.signal ?? context.signal)).consume({ ...request, accessToken, now: Date.now(),
        signal: options?.signal ?? context.signal,
        expectedProviderAccountId: await readCredential(context.credentials, PROVIDER_ACCOUNT_ID_KEY, options) || null,
        expectedProviderOrganizationId: await readCredential(context.credentials, ORGANIZATION_UUID_KEY, options) || null });
      return { status };
    },
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
    if (!usesClaudeOAuthCredentials(authenticationModeId)) {
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
      const [accessToken, subscriptionType] = await Promise.all([
        readCredential(context.credentials, ACCESS_TOKEN_KEY, options),
        readCredential(context.credentials, SUBSCRIPTION_TYPE_KEY, options),
      ]);
      if (!accessToken) throw new Error('Claude OAuth credentials are unavailable');
      return {
        kind: 'httpHeaders',
        usageAccountScope: classifyUsageAccountScope(subscriptionType),
        headers: { authorization: `Bearer ${accessToken}` },
      };
    }
    if (request.kind !== 'files') {
      throw new Error('Claude OAuth accounts do not support HTTP-header materialization');
    }
    const files: Record<string, Uint8Array> = {};
    if (!request.fileIds.includes(CLAUDE_CREDENTIAL_FILE_ID)) return { kind: 'files', files };
    // These fields belong to the same admitted credential revision. Each read
    // keeps the host's currentness checks; none depends on another field.
    const [accessToken, expiresAtValue, planMetadata, scopes, providerAccountId, providerEmail, organizationUuid] = await Promise.all([
      readCredential(context.credentials, ACCESS_TOKEN_KEY, options),
      readCredential(context.credentials, EXPIRES_AT_MS_KEY, options),
      readPlanMetadata(context.credentials, options),
      readScopes(context.credentials, options),
      readCredential(context.credentials, PROVIDER_ACCOUNT_ID_KEY, options),
      readCredential(context.credentials, PROVIDER_EMAIL_KEY, options),
      readCredential(context.credentials, ORGANIZATION_UUID_KEY, options),
    ]);
    if (!accessToken) throw new Error('Claude OAuth credentials are unavailable');
    const expiresAt = Number(expiresAtValue);
    const payload = {
      claudeAiOauth: {
        accessToken,
        ...planMetadata,
        ...(Number.isFinite(expiresAt) && expiresAt > 0 ? { expiresAt } : {}),
        scopes,
      },
    };
    files[CLAUDE_CREDENTIAL_FILE_ID] = new TextEncoder().encode(JSON.stringify(payload));
    if (request.fileIds.includes('.claude.json')) {
      let rootConfig: unknown = null;
      const existingConfig = options?.existingFiles?.['.claude.json'];
      if (existingConfig !== undefined) {
        try {
          rootConfig = JSON.parse(new TextDecoder().decode(existingConfig));
        } catch {
          throw new PluginError({ code: 'claude_subscription_native_config_invalid',
            message: 'Claude native account configuration is invalid.' });
        }
      }
      files['.claude.json'] = new TextEncoder().encode(JSON.stringify(reconcileClaudeNativeAccountConfig({
        rootConfig,
        providerAccountId: providerAccountId || null, providerEmail: providerEmail || null,
        providerOrganizationId: organizationUuid || null,
      })));
    }
    return { kind: 'files', files, usageAccountScope: classifyUsageAccountScope(planMetadata.subscriptionType) };
  },
};

  return Object.freeze(claudeSubscriptionRuntimeDefinition);
}

export const claudeSubscriptionConnectedAccountRuntime = createClaudeSubscriptionConnectedAccountRuntime();
