import {
  ConnectedServiceCredentialRecordV1Schema,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceId,
} from './connectedServiceSchemas.js';

export type ConnectedServiceOauthCredentialRawMetadata = Readonly<{
  claudeAiOauth?: Readonly<{
    subscriptionType?: string;
    rateLimitTier?: string;
  }>;
  'claude.ai_oauth'?: Readonly<{
    subscriptionType?: string;
    rateLimitTier?: string;
  }>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeConnectedServiceOauthCredentialRawMetadata(
  raw: unknown,
): ConnectedServiceOauthCredentialRawMetadata | null {
  const root = isRecord(raw) ? raw : {};
  const claudeAiOauthRaw = isRecord(root.claudeAiOauth)
    ? root.claudeAiOauth
    : isRecord(root['claude.ai_oauth'])
      ? root['claude.ai_oauth']
      : {};
  const subscriptionType = readString(claudeAiOauthRaw.subscriptionType);
  const rateLimitTier = readString(claudeAiOauthRaw.rateLimitTier);
  const claudeAiOauth = {
    ...(subscriptionType ? { subscriptionType } : {}),
    ...(rateLimitTier ? { rateLimitTier } : {}),
  };
  return Object.keys(claudeAiOauth).length > 0 ? { claudeAiOauth } : null;
}

export function buildConnectedServiceCredentialRecord(
  params:
    | Readonly<{
        now: number;
        serviceId: ConnectedServiceId;
        profileId: string;
        kind: 'oauth';
        expiresAt?: number | null;
        oauth: Readonly<{
          accessToken: string;
          refreshToken: string;
          idToken: string | null;
          scope: string | null;
          tokenType: string | null;
          providerAccountId: string | null;
          providerEmail: string | null;
          raw?: ConnectedServiceOauthCredentialRawMetadata | null;
        }>;
      }>
    | Readonly<{
        now: number;
        serviceId: ConnectedServiceId;
        profileId: string;
        kind: 'token';
        token: Readonly<{
          token: string;
          providerAccountId: string | null;
          providerEmail: string | null;
        }>;
      }>,
): ConnectedServiceCredentialRecordV1 {
  const base = {
    v: 1 as const,
    serviceId: params.serviceId,
    profileId: params.profileId,
    createdAt: params.now,
    updatedAt: params.now,
    expiresAt: params.kind === 'oauth' ? (params.expiresAt ?? null) : null,
  };

  const record: unknown =
    params.kind === 'oauth'
      ? {
          ...base,
          kind: 'oauth' as const,
          oauth: {
            accessToken: params.oauth.accessToken,
            refreshToken: params.oauth.refreshToken,
            idToken: params.oauth.idToken,
            scope: params.oauth.scope,
            tokenType: params.oauth.tokenType,
            providerAccountId: params.oauth.providerAccountId,
            providerEmail: params.oauth.providerEmail,
            raw: normalizeConnectedServiceOauthCredentialRawMetadata(params.oauth.raw),
          },
          token: null,
        }
      : {
          ...base,
          kind: 'token' as const,
          token: {
            token: params.token.token,
            providerAccountId: params.token.providerAccountId,
            providerEmail: params.token.providerEmail,
            raw: null,
          },
        };

  return ConnectedServiceCredentialRecordV1Schema.parse(record);
}
