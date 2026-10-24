import {
  AGY_OAUTH_CLIENT_ID,
  AGY_OAUTH_CLIENT_SECRET,
  AGY_OAUTH_TOKEN_URL,
  AGY_OAUTH_SCOPES,
  CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
  CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPES,
  CLAUDE_CODE_REQUIRED_OAUTH_SCOPES,
  CLAUDE_OAUTH_PROFILE_BETA_HEADER,
  CLAUDE_OAUTH_PROFILE_URL,
  CLAUDE_OAUTH_CLIENT_ID,
  CLAUDE_OAUTH_TOKEN_URL,
  GEMINI_CLI_OAUTH_CLIENT_ID,
  GEMINI_CLI_OAUTH_CLIENT_SECRET,
  GEMINI_CLI_OAUTH_SCOPES,
  GEMINI_CLI_OAUTH_TOKEN_URL,
  OPENAI_CODEX_OAUTH_CLIENT_ID,
  OPENAI_CODEX_OAUTH_TOKEN_URL,
  normalizeClaudeOauthProfileEntitlement,
} from '@happier-dev/agents';
import {
  ConnectedServiceIdSchema,
  type ConnectedServiceId,
  type ConnectedServiceCredentialHealthV1,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceOauthCredentialRawMetadata,
  readConnectedServiceCredentialOrganizationId as readCredentialOrganizationId,
} from '@happier-dev/protocol';

import {
  extractOpenAiCodexAccountId,
  extractOpenAiCodexEmail,
} from './openAiCodexIdentityClaims';

type EnvLike = Readonly<Record<string, string | undefined>>;

export const CLAUDE_SUBSCRIPTION_OAUTH_SCOPES = CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPES;
export const CLAUDE_SUBSCRIPTION_OAUTH_SCOPE = CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE;
export const CLAUDE_SUBSCRIPTION_REQUIRED_CLAUDE_CODE_SCOPES = CLAUDE_CODE_REQUIRED_OAUTH_SCOPES;

export type ConnectedAccountOauthRefreshResponseIdentity = Readonly<{
  providerAccountId?: string | null;
  providerEmail?: string | null;
}>;

export type ConnectedAccountRefreshCredentialEvidence =
  | Readonly<{
      status: 'accepted';
      raw: ConnectedServiceOauthCredentialRawMetadata | null;
      providerAccountId?: string | null;
      providerEmail?: string | null;
    }>
  | Readonly<{
      status: 'rejected';
      providerStatus: number;
      providerErrorCode: string | null;
    }>
  | Readonly<{
      status: 'unavailable';
    }>
  | Readonly<{
      status: 'identity_mismatch';
    }>;

export type ConnectedAccountOAuthDescriptor = Readonly<{
  clientIdEnv?: string;
  defaultClientId: string;
  tokenUrlEnv?: string;
  defaultTokenUrl: string;
  refreshTokenBody: 'form' | 'json';
  scopes: readonly string[];
  clientSecretEnv?: string;
  defaultClientSecret?: string;
  mapCredentialPayload: (input: Readonly<{
    now: number;
    payload: unknown;
  }>) => ConnectedAccountOauthCredentialPayload;
  /**
   * CS-FIX-4: provider-owned identity extraction from a REFRESH response. Providers whose account
   * identity is carried in the refresh id_token (e.g. openai-codex) implement this so the central
   * refresher (`refreshConnectedAccountOauthTokens`) stays config-driven with no provider-name
   * branch. Absent ⇒ the refresh response carries no provider identity.
   */
  extractRefreshResponseIdentity?: (input: Readonly<{
    idToken: string | null;
    payload: unknown;
  }>) => ConnectedAccountOauthRefreshResponseIdentity;
  resolveRefreshCredentialEvidence?: (input: Readonly<{
    accessToken: string;
    expectedProviderAccountId?: string | null;
    fetcher: typeof fetch;
    signal?: AbortSignal;
  }>) => Promise<ConnectedAccountRefreshCredentialEvidence>;
}>;

export type ConnectedAccountOauthCredentialPayload = Readonly<{
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  scope: string | null;
  tokenType: string | null;
  providerAccountId: string | null;
  providerEmail: string | null;
  expiresAt: number | null;
  raw: ConnectedServiceOauthCredentialRawMetadata | null;
}>;

export type ConnectedAccountDescriptor = Readonly<{
  id: ConnectedServiceId;
  displayName: string;
  providerDisplayName?: string;
  credentialKind: 'oauth' | 'token' | 'oauth-or-token';
  oauth?: ConnectedAccountOAuthDescriptor;
  resolvePostRefreshCredentialHealth?: (input: Readonly<{
    credential: ConnectedServiceCredentialRecordV1;
    now: number;
  }>) => ConnectedServiceCredentialHealthV1 | null;
  ui?: Readonly<{
    iconName: string;
    oauthAddActionModes: readonly string[];
  }>;
}>;

export type ResolvedConnectedAccountOauthConfig = Readonly<{
  clientId: string;
  clientSecret?: string;
  tokenUrl: string;
  refreshTokenBody: 'form' | 'json';
  scopes: readonly string[];
  extractRefreshResponseIdentity?: (input: Readonly<{
    idToken: string | null;
    payload: unknown;
  }>) => ConnectedAccountOauthRefreshResponseIdentity;
  resolveRefreshCredentialEvidence?: (input: Readonly<{
    accessToken: string;
    expectedProviderAccountId?: string | null;
    fetcher: typeof fetch;
    signal?: AbortSignal;
  }>) => Promise<ConnectedAccountRefreshCredentialEvidence>;
}>;

function resolveNonEmptyEnv(raw: string | undefined, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  return trimmed ? trimmed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readRequiredString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseOauthScopeSet(scope: string | null | undefined): ReadonlySet<string> {
  const values = typeof scope === 'string'
    ? scope.split(/\s+/).map((part) => part.trim()).filter(Boolean)
    : [];
  return new Set(values);
}

export function resolveMissingClaudeSubscriptionClaudeCodeScopes(scope: string | null | undefined): readonly string[] {
  const scopeSet = parseOauthScopeSet(scope);
  return CLAUDE_SUBSCRIPTION_REQUIRED_CLAUDE_CODE_SCOPES.filter((requiredScope) => !scopeSet.has(requiredScope));
}

export function hasClaudeSubscriptionClaudeCodeScopes(scope: string | null | undefined): boolean {
  return resolveMissingClaudeSubscriptionClaudeCodeScopes(scope).length === 0;
}

function resolveExpiresAtFromPayload(input: Readonly<{
  now: number;
  payload: Record<string, unknown>;
  allowAbsoluteExpiresAt?: boolean;
}>): number | null {
  if (input.allowAbsoluteExpiresAt) {
    const explicit = input.payload.expires_at;
    if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) {
      return explicit;
    }
  }
  const expiresIn = input.payload.expires_in;
  if (typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0) {
    return input.now + Math.trunc(expiresIn) * 1000;
  }
  return null;
}

export type ClaudeSubscriptionProfileContextResult =
  | Readonly<{ status: 'accepted'; raw: ConnectedServiceOauthCredentialRawMetadata | null;
      providerAccountId: string | null; providerEmail: string | null }>
  | Readonly<{ status: 'rejected'; providerStatus: number; providerErrorCode: null }>
  | Readonly<{ status: 'unavailable' }>
  | Readonly<{ status: 'identity_mismatch' }>;

export async function fetchClaudeSubscriptionProfileContext(input: Readonly<{
  accessToken: string;
  expectedProviderAccountId?: string | null;
  profileUrl?: string;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}>): Promise<ClaudeSubscriptionProfileContextResult> {
  const response = await (input.fetcher ?? fetch)(input.profileUrl ?? CLAUDE_OAUTH_PROFILE_URL, {
    method: 'GET',
    headers: { Authorization: `Bearer ${input.accessToken}`, 'anthropic-beta': CLAUDE_OAUTH_PROFILE_BETA_HEADER },
    signal: input.signal,
  });
  if (response.status === 401) return { status: 'rejected', providerStatus: response.status, providerErrorCode: null };
  if (!response.ok) return { status: 'unavailable' };
  const payload: unknown = await response.json();
  const account = isRecord(payload) && isRecord(payload.account) ? payload.account : null;
  const providerAccountId = readString(account?.uuid);
  const expectedProviderAccountId = input.expectedProviderAccountId?.trim();
  if (expectedProviderAccountId && !providerAccountId) return { status: 'unavailable' };
  if (expectedProviderAccountId && providerAccountId !== expectedProviderAccountId) return { status: 'identity_mismatch' };
  return { status: 'accepted', raw: normalizeClaudeOauthProfileEntitlement(payload),
    providerAccountId, providerEmail: readString(account?.email_address) ?? readString(account?.email) };
}

export function readConnectedServiceCredentialOrganizationId(record: ConnectedServiceCredentialRecordV1): string | null {
  return readCredentialOrganizationId(record);
}

export const CONNECTED_ACCOUNT_DESCRIPTORS = [
  {
    id: 'antigravity',
    displayName: 'Google Antigravity',
    providerDisplayName: 'Antigravity',
    credentialKind: 'oauth',
    oauth: {
      defaultClientId: AGY_OAUTH_CLIENT_ID,
      defaultClientSecret: AGY_OAUTH_CLIENT_SECRET,
      defaultTokenUrl: AGY_OAUTH_TOKEN_URL,
      refreshTokenBody: 'form',
      scopes: AGY_OAUTH_SCOPES,
      mapCredentialPayload: ({ now, payload }) => {
        const data = isRecord(payload) ? payload : {};
        const projectId = readString(data.project_id);
        return {
          accessToken: readRequiredString(data.access_token),
          refreshToken: readRequiredString(data.refresh_token),
          idToken: readString(data.id_token),
          scope: readString(data.scope),
          tokenType: readString(data.token_type),
          providerAccountId: readString(data.providerAccountId),
          providerEmail: readString(data.providerEmail),
          expiresAt: resolveExpiresAtFromPayload({ now, payload: data }),
          raw: projectId ? { project_id: projectId } : null,
        };
      },
    },
    ui: { iconName: 'google', oauthAddActionModes: ['paste'] },
  },
  {
    id: 'openai-codex',
    displayName: 'OpenAI Codex',
    providerDisplayName: 'OpenAI',
    credentialKind: 'oauth',
    oauth: {
      clientIdEnv: 'HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_CLIENT_ID',
      defaultClientId: OPENAI_CODEX_OAUTH_CLIENT_ID,
      tokenUrlEnv: 'HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_TOKEN_URL',
      defaultTokenUrl: OPENAI_CODEX_OAUTH_TOKEN_URL,
      refreshTokenBody: 'form',
      scopes: [],
      mapCredentialPayload: ({ now, payload }) => {
        const data = isRecord(payload) ? payload : {};
        const idToken = readString(data.id_token);
        return {
          accessToken: readRequiredString(data.access_token),
          refreshToken: readRequiredString(data.refresh_token),
          idToken,
          scope: null,
          tokenType: null,
          providerAccountId: readString(data.account_id) ?? extractOpenAiCodexAccountId(idToken),
          providerEmail: extractOpenAiCodexEmail(idToken),
          expiresAt: resolveExpiresAtFromPayload({ now, payload: data, allowAbsoluteExpiresAt: true }),
          raw: null,
        };
      },
      extractRefreshResponseIdentity: ({ idToken }) => ({
        providerAccountId: extractOpenAiCodexAccountId(idToken),
        providerEmail: extractOpenAiCodexEmail(idToken),
      }),
    },
    ui: { iconName: 'openai', oauthAddActionModes: ['device', 'browser'] },
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    providerDisplayName: 'OpenAI',
    credentialKind: 'token',
    ui: { iconName: 'openai', oauthAddActionModes: [] },
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    providerDisplayName: 'Claude',
    credentialKind: 'token',
    ui: { iconName: 'anthropic', oauthAddActionModes: [] },
  },
  {
    id: 'claude-subscription',
    displayName: 'Claude subscription',
    providerDisplayName: 'Claude',
    credentialKind: 'oauth',
    oauth: {
      clientIdEnv: 'HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_CLIENT_ID',
      defaultClientId: CLAUDE_OAUTH_CLIENT_ID,
      tokenUrlEnv: 'HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL',
      defaultTokenUrl: CLAUDE_OAUTH_TOKEN_URL,
      refreshTokenBody: 'json',
      scopes: CLAUDE_SUBSCRIPTION_OAUTH_SCOPES,
      mapCredentialPayload: ({ now, payload }) => {
        const data = isRecord(payload) ? payload : {};
        const account = isRecord(data.account) ? data.account : {};
        return {
          accessToken: readRequiredString(data.access_token),
          refreshToken: readRequiredString(data.refresh_token),
          idToken: null,
          scope: readString(data.scope),
          tokenType: readString(data.token_type),
          providerAccountId: readString(account.uuid),
          providerEmail: readString(account.email_address),
          expiresAt: resolveExpiresAtFromPayload({ now, payload: data }),
          raw: normalizeClaudeOauthProfileEntitlement(data),
        };
      },
      resolveRefreshCredentialEvidence: fetchClaudeSubscriptionProfileContext,
    },
    resolvePostRefreshCredentialHealth: ({ credential, now }) => {
      if (
        credential.kind !== 'oauth'
        || resolveMissingClaudeSubscriptionClaudeCodeScopes(credential.oauth.scope).length === 0
      ) {
        return null;
      }
      return {
        v: 1,
        status: 'needs_reauth',
        reconnectRequired: true,
        lastRefreshAttemptAt: now,
        lastRefreshFailureAt: now,
        lastRefreshFailureKind: 'provider_403',
        providerHttpStatus: 403,
        providerErrorCode: 'missing_claude_code_scope',
      };
    },
    ui: { iconName: 'claude', oauthAddActionModes: ['browser'] },
  },
  {
    id: 'gemini',
    displayName: 'Gemini',
    providerDisplayName: 'Gemini',
    credentialKind: 'oauth',
    oauth: {
      clientIdEnv: 'HAPPIER_CONNECTED_SERVICES_GEMINI_OAUTH_CLIENT_ID',
      defaultClientId: GEMINI_CLI_OAUTH_CLIENT_ID,
      clientSecretEnv: 'HAPPIER_CONNECTED_SERVICES_GEMINI_OAUTH_CLIENT_SECRET',
      defaultClientSecret: GEMINI_CLI_OAUTH_CLIENT_SECRET,
      tokenUrlEnv: 'HAPPIER_CONNECTED_SERVICES_GEMINI_OAUTH_TOKEN_URL',
      defaultTokenUrl: GEMINI_CLI_OAUTH_TOKEN_URL,
      refreshTokenBody: 'form',
      scopes: GEMINI_CLI_OAUTH_SCOPES,
      mapCredentialPayload: ({ now, payload }) => {
        const data = isRecord(payload) ? payload : {};
        return {
          accessToken: readRequiredString(data.access_token),
          refreshToken: readRequiredString(data.refresh_token),
          idToken: readString(data.id_token),
          scope: readString(data.scope),
          tokenType: readString(data.token_type),
          providerAccountId: null,
          providerEmail: null,
          expiresAt: resolveExpiresAtFromPayload({ now, payload: data }),
          raw: null,
        };
      },
    },
    ui: { iconName: 'gemini', oauthAddActionModes: ['browser'] },
  },
  {
    id: 'github',
    displayName: 'GitHub',
    providerDisplayName: 'GitHub',
    credentialKind: 'token',
    ui: { iconName: 'github', oauthAddActionModes: [] },
  },
] satisfies readonly ConnectedAccountDescriptor[];

const DESCRIPTORS_BY_ID: ReadonlyMap<ConnectedServiceId, ConnectedAccountDescriptor> =
  new Map(CONNECTED_ACCOUNT_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]));

export function getConnectedAccountDescriptor(serviceId: ConnectedServiceId): ConnectedAccountDescriptor | null {
  return DESCRIPTORS_BY_ID.get(serviceId) ?? null;
}

export function resolveConnectedAccountPostRefreshCredentialHealth(input: Readonly<{
  credential: ConnectedServiceCredentialRecordV1;
  now: number;
}>): ConnectedServiceCredentialHealthV1 | null {
  const descriptor = getConnectedAccountDescriptor(input.credential.serviceId);
  return descriptor?.resolvePostRefreshCredentialHealth?.(input) ?? null;
}

export function resolveConnectedServiceProviderDisplayName(serviceId: string, explicit?: string | null): string {
  const serviceIdParsed = ConnectedServiceIdSchema.safeParse(serviceId);
  const normalizedExplicit = readString(explicit?.replace(/\s+/g, ' ').trim());
  if (!serviceIdParsed.success) return normalizedExplicit ?? 'Provider';
  const descriptor = getConnectedAccountDescriptor(serviceIdParsed.data);
  return readString(descriptor?.providerDisplayName)
    ?? normalizedExplicit
    ?? readString(descriptor?.displayName)
    ?? 'Provider';
}

export function requireConnectedAccountDescriptor(serviceId: ConnectedServiceId): ConnectedAccountDescriptor {
  const descriptor = getConnectedAccountDescriptor(serviceId);
  if (!descriptor) {
    throw new Error(`Unsupported connected account: ${serviceId}`);
  }
  return descriptor;
}

export function resolveConnectedAccountOauthConfig(
  serviceId: ConnectedServiceId,
  env: EnvLike,
): ResolvedConnectedAccountOauthConfig {
  const descriptor = requireConnectedAccountDescriptor(serviceId);
  if (!descriptor.oauth) {
    throw new Error(`Connected account does not support OAuth refresh: ${serviceId}`);
  }
  const oauth = descriptor.oauth;
  const clientId = resolveNonEmptyEnv(oauth.clientIdEnv ? env[oauth.clientIdEnv] : undefined, oauth.defaultClientId);
  const tokenUrl = resolveNonEmptyEnv(oauth.tokenUrlEnv ? env[oauth.tokenUrlEnv] : undefined, oauth.defaultTokenUrl);
  const clientSecret =
    oauth.defaultClientSecret
      ? resolveNonEmptyEnv(oauth.clientSecretEnv ? env[oauth.clientSecretEnv] : undefined, oauth.defaultClientSecret)
      : undefined;

  return {
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    tokenUrl,
    refreshTokenBody: oauth.refreshTokenBody,
    scopes: oauth.scopes,
    ...(oauth.extractRefreshResponseIdentity
      ? { extractRefreshResponseIdentity: oauth.extractRefreshResponseIdentity }
      : {}),
    ...(oauth.resolveRefreshCredentialEvidence
      ? { resolveRefreshCredentialEvidence: oauth.resolveRefreshCredentialEvidence }
      : {}),
  };
}
