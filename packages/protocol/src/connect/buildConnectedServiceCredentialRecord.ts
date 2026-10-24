import {
  ConnectedServiceCredentialRecordV1Schema,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceId,
} from './connectedServiceSchemas.js';
import { readClaudeOauthCredentialMetadata, readClaudeOauthCredentialOrganizationId, type ClaudeOauthCredentialMetadata } from '../providers/claude/oauthProfile.js';

export type ConnectedServiceOauthCredentialRawMetadata = Readonly<{
  project_id?: string;
  claudeAiOauth?: ClaudeOauthCredentialMetadata;
  'claude.ai_oauth'?: ClaudeOauthCredentialMetadata;
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
  serviceId?: ConnectedServiceId,
): ConnectedServiceOauthCredentialRawMetadata | null {
  const root = isRecord(raw) ? raw : {};
  const projectId = serviceId === 'antigravity' ? readString(root.project_id) : undefined;
  const claudeAiOauth = readClaudeOauthCredentialMetadata(raw);
  const normalized = {
    ...(claudeAiOauth ? { claudeAiOauth } : {}),
    ...(projectId ? { project_id: projectId } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : null;
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
            raw: normalizeConnectedServiceOauthCredentialRawMetadata(params.oauth.raw, params.serviceId),
          },
          token: null,
        }
      : {
          ...base,
          kind: 'token' as const,
          oauth: null,
          token: {
            token: params.token.token,
            providerAccountId: params.token.providerAccountId,
            providerEmail: params.token.providerEmail,
            raw: null,
          },
        };

  return ConnectedServiceCredentialRecordV1Schema.parse(record);
}

/** Provider usage identity requirements shared by credential writers and usage consumers. */
export function connectedServiceUsageRequiresOrganizationId(serviceId: ConnectedServiceId): boolean {
  return serviceId === 'claude-subscription';
}

export function readConnectedServiceCredentialOrganizationId(record: ConnectedServiceCredentialRecordV1): string | null {
  return connectedServiceUsageRequiresOrganizationId(record.serviceId) && record.kind === 'oauth'
    ? readClaudeOauthCredentialOrganizationId(record.oauth.raw)
    : null;
}

export type ConnectedServiceCredentialMetadata = Readonly<{
  kind: 'oauth' | 'token';
  providerEmail: string | null;
  providerAccountId: string | null;
  providerOrganizationId?: string | null;
  expiresAt: number | null;
}>;

/** Public, non-secret projection of the credential's attested provider identity. */
export function buildConnectedServiceCredentialMetadata(record: ConnectedServiceCredentialRecordV1): ConnectedServiceCredentialMetadata {
  const identity = record.kind === 'oauth' ? record.oauth : record.token;
  const providerOrganizationId = readConnectedServiceCredentialOrganizationId(record);
  return {
    kind: record.kind,
    providerEmail: identity.providerEmail ?? null,
    providerAccountId: identity.providerAccountId ?? null,
    ...(providerOrganizationId ? { providerOrganizationId } : {}),
    expiresAt: record.expiresAt,
  };
}
