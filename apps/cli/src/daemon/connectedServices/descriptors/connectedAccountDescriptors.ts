import type { ConnectedServiceId } from '@happier-dev/protocol';

type EnvLike = Readonly<Record<string, string | undefined>>;

export type ConnectedAccountOAuthDescriptor = Readonly<{
  clientIdEnv: string;
  defaultClientId: string;
  tokenUrlEnv: string;
  defaultTokenUrl: string;
  refreshTokenBody: 'form' | 'json';
  scopes: readonly string[];
  clientSecretEnv?: string;
  defaultClientSecret?: string;
  mapCredentialPayload: (input: Readonly<{
    now: number;
    payload: unknown;
  }>) => ConnectedAccountOauthCredentialPayload;
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
}>;

export type ConnectedAccountDescriptor = Readonly<{
  id: ConnectedServiceId;
  displayName: string;
  credentialKind: 'oauth' | 'token' | 'oauth-or-token';
  oauth?: ConnectedAccountOAuthDescriptor;
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

export const CONNECTED_ACCOUNT_DESCRIPTORS = [
  {
    id: 'openai-codex',
    displayName: 'OpenAI Codex',
    credentialKind: 'oauth',
    oauth: {
      clientIdEnv: 'HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_CLIENT_ID',
      defaultClientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
      tokenUrlEnv: 'HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_TOKEN_URL',
      defaultTokenUrl: 'https://auth.openai.com/oauth/token',
      refreshTokenBody: 'form',
      scopes: [],
      mapCredentialPayload: ({ now, payload }) => {
        const data = isRecord(payload) ? payload : {};
        return {
          accessToken: readRequiredString(data.access_token),
          refreshToken: readRequiredString(data.refresh_token),
          idToken: readString(data.id_token),
          scope: null,
          tokenType: null,
          providerAccountId: readString(data.account_id),
          providerEmail: null,
          expiresAt: resolveExpiresAtFromPayload({ now, payload: data, allowAbsoluteExpiresAt: true }),
        };
      },
    },
    ui: { iconName: 'openai', oauthAddActionModes: ['device', 'browser'] },
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    credentialKind: 'token',
    ui: { iconName: 'openai', oauthAddActionModes: [] },
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    credentialKind: 'token',
    ui: { iconName: 'anthropic', oauthAddActionModes: [] },
  },
  {
    id: 'claude-subscription',
    displayName: 'Claude subscription',
    credentialKind: 'oauth',
    oauth: {
      clientIdEnv: 'HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_CLIENT_ID',
      defaultClientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
      tokenUrlEnv: 'HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL',
      defaultTokenUrl: 'https://console.anthropic.com/v1/oauth/token',
      refreshTokenBody: 'json',
      scopes: [],
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
        };
      },
    },
    ui: { iconName: 'claude', oauthAddActionModes: ['browser'] },
  },
  {
    id: 'gemini',
    displayName: 'Gemini',
    credentialKind: 'oauth',
    oauth: {
      clientIdEnv: 'HAPPIER_CONNECTED_SERVICES_GEMINI_OAUTH_CLIENT_ID',
      defaultClientId: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
      clientSecretEnv: 'HAPPIER_CONNECTED_SERVICES_GEMINI_OAUTH_CLIENT_SECRET',
      defaultClientSecret: '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l',
      tokenUrlEnv: 'HAPPIER_CONNECTED_SERVICES_GEMINI_OAUTH_TOKEN_URL',
      defaultTokenUrl: 'https://oauth2.googleapis.com/token',
      refreshTokenBody: 'form',
      scopes: [],
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
        };
      },
    },
    ui: { iconName: 'gemini', oauthAddActionModes: ['browser'] },
  },
  {
    id: 'github',
    displayName: 'GitHub',
    credentialKind: 'token',
    ui: { iconName: 'github', oauthAddActionModes: [] },
  },
] satisfies readonly ConnectedAccountDescriptor[];

const DESCRIPTORS_BY_ID: ReadonlyMap<ConnectedServiceId, ConnectedAccountDescriptor> =
  new Map(CONNECTED_ACCOUNT_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]));

export function getConnectedAccountDescriptor(serviceId: ConnectedServiceId): ConnectedAccountDescriptor | null {
  return DESCRIPTORS_BY_ID.get(serviceId) ?? null;
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
  const clientId = resolveNonEmptyEnv(env[oauth.clientIdEnv], oauth.defaultClientId);
  const tokenUrl = resolveNonEmptyEnv(env[oauth.tokenUrlEnv], oauth.defaultTokenUrl);
  const clientSecret =
    oauth.clientSecretEnv && oauth.defaultClientSecret
      ? resolveNonEmptyEnv(env[oauth.clientSecretEnv], oauth.defaultClientSecret)
      : undefined;

  return {
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    tokenUrl,
    refreshTokenBody: oauth.refreshTokenBody,
    scopes: oauth.scopes,
  };
}
