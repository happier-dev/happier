import { createHash } from 'node:crypto';

import { computeConnectedServiceAccessTokenFingerprint } from '@/daemon/connectedServices/refresh/credentialFreshness/tokenFingerprint';
import { parseClaudeCodeCredentialScopes } from './claudeCodeCredentialScopes';

export type ClaudeCodeNativeCredentialPayload = Readonly<{
  claudeAiOauth: Readonly<{
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes: readonly string[];
    subscriptionType?: string;
    rateLimitTier?: string;
  }>;
}>;

export type ClaudeCodeCredentialFreshness = Readonly<{
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  updatedAtMs: number;
}>;

export type ClaudeCodeCredentialComparatorSource = 'file' | 'macos_keychain' | 'incoming';

export function readObject(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function readOptionalString(value: unknown): string | undefined {
  const text = readString(value);
  return text ?? undefined;
}

export function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function readStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

export function readClaudeCodeNativeCredentialPayload(
  value: unknown,
): ClaudeCodeNativeCredentialPayload | null {
  const root = readObject(value);
  const credential = readObject(root?.claudeAiOauth);
  const accessToken = readString(credential?.accessToken);
  const refreshToken = readString(credential?.refreshToken);
  if (!credential || !accessToken) return null;
  const expiresAt = readNumber(credential.expiresAt);
  const subscriptionType = readOptionalString(credential.subscriptionType);
  const rateLimitTier = readOptionalString(credential.rateLimitTier);
  return {
    claudeAiOauth: {
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      ...(expiresAt !== null ? { expiresAt } : {}),
      scopes: parseClaudeCodeCredentialScopes(
        readStringArray(credential.scopes).length > 0
          ? readStringArray(credential.scopes)
          : typeof credential.scopes === 'string'
            ? credential.scopes
            : null,
      ),
      ...(subscriptionType ? { subscriptionType } : {}),
      ...(rateLimitTier ? { rateLimitTier } : {}),
    },
  };
}

/**
 * Claude Code's saved sign-in to an enterprise gateway (`/login` with `forceLoginMethod: gateway`),
 * stored in the same secure storage as `claudeAiOauth`.
 *
 * `gatewayTrust` maps the gateway hostname to the SHA-256 fingerprint of the TLS certificate
 * Claude Code pinned at sign-in. Happier requires that pin for its own HTTPS catalog requests.
 */
export type ClaudeCodeGatewayLogin = Readonly<{
  url: string;
  accessToken: string;
  expiresAt: number | null;
  tlsCertificateSha256: string;
}>;

const SHA256_HEX = /^[0-9a-f]{64}$/u;

function readClaudeCodeGatewayLogin(root: Record<string, unknown>, value: unknown): ClaudeCodeGatewayLogin | null {
  const gateway = readObject(value);
  const url = readString(gateway?.url)?.trim() ?? null;
  const accessToken = readString(gateway?.jwt)?.trim() ?? null;
  if (!gateway || !url || !accessToken) return null;
  let hostname: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    hostname = parsed.hostname.replace(/^\[|\]$/gu, '');
  } catch {
    return null;
  }
  const tlsCertificateSha256 = readString(readObject(root.gatewayTrust)?.[hostname])?.trim().toLowerCase() ?? null;
  if (!tlsCertificateSha256 || !SHA256_HEX.test(tlsCertificateSha256)) return null;
  return { url, accessToken, expiresAt: readNumber(gateway.expiresAt), tlsCertificateSha256 };
}

export type ClaudeCodeCatalogSignIn =
  | Readonly<{ kind: 'gateway'; login: ClaudeCodeGatewayLogin | null }>
  | Readonly<{ kind: 'subscription'; accessToken: string }>;

export function readClaudeCodeCatalogSignIn(value: unknown): ClaudeCodeCatalogSignIn | null {
  const root = readObject(value);
  if (!root) return null;
  // Claude Code ignores earlier Claude.ai sign-ins while signed in to a gateway.
  // An unusable gateway sign-in also cannot authorize discovery under that earlier account.
  if (root.enterpriseGateway != null) {
    return { kind: 'gateway', login: readClaudeCodeGatewayLogin(root, root.enterpriseGateway) };
  }
  const subscription = readClaudeCodeNativeCredentialPayload(root);
  return subscription ? { kind: 'subscription', accessToken: subscription.claudeAiOauth.accessToken.trim() } : null;
}

function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, canonicalizeJsonValue(nested)]),
    );
  }
  return value;
}

export function computeClaudeCodeCredentialFingerprint(payload: unknown): string {
  const canonical = JSON.stringify(canonicalizeJsonValue(payload));
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

// RR-4: single fingerprint owner — Claude-local alias of the canonical generic helper (two
// identical implementations were a split-brain drift risk).
export function computeClaudeCodeCredentialSafeTokenFingerprint(value: string): string {
  return computeConnectedServiceAccessTokenFingerprint(value);
}

export function computeClaudeCodeCredentialAccountProofFingerprint(payload: unknown): string | null {
  const root = readObject(payload);
  const credential = readObject(root?.claudeAiOauth);
  const accessToken = readString(credential?.accessToken);
  const refreshToken = readString(credential?.refreshToken);
  if (!accessToken) return null;
  const subscriptionType = readOptionalString(credential?.subscriptionType);
  const rateLimitTier = readOptionalString(credential?.rateLimitTier);

  return computeClaudeCodeCredentialFingerprint({
    claudeAiOauth: {
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      scopes: parseClaudeCodeCredentialScopes(
        Array.isArray(credential?.scopes)
          ? credential.scopes.filter((scope): scope is string => typeof scope === 'string')
          : typeof credential?.scopes === 'string'
            ? credential.scopes
            : null,
      ),
      ...(subscriptionType ? { subscriptionType } : {}),
      ...(rateLimitTier ? { rateLimitTier } : {}),
    },
  });
}

export function readClaudeCodeCredentialFreshness(
  payload: ClaudeCodeNativeCredentialPayload,
  updatedAtMs: number,
): ClaudeCodeCredentialFreshness {
  const expiresAt = typeof payload.claudeAiOauth.expiresAt === 'number' && Number.isFinite(payload.claudeAiOauth.expiresAt)
    ? payload.claudeAiOauth.expiresAt
    : null;
  return {
    accessToken: payload.claudeAiOauth.accessToken,
    refreshToken: payload.claudeAiOauth.refreshToken ?? null,
    expiresAt,
    updatedAtMs,
  };
}

export function isExistingClaudeCodeCredentialNewer(params: Readonly<{
  existing: ClaudeCodeCredentialFreshness;
  incoming: ClaudeCodeCredentialFreshness;
}>): boolean {
  if (
    params.existing.refreshToken !== null
    && params.existing.refreshToken === params.incoming.refreshToken
  ) return false;
  if (
    params.existing.refreshToken === null
    && params.incoming.refreshToken === null
    && params.existing.accessToken === params.incoming.accessToken
  ) return false;
  if (params.existing.updatedAtMs > params.incoming.updatedAtMs) return true;
  return params.existing.expiresAt !== null
    && (params.incoming.expiresAt === null || params.existing.expiresAt > params.incoming.expiresAt);
}

export function buildSafeClaudeCodeCredentialComparatorEntry(
  payload: ClaudeCodeNativeCredentialPayload,
  freshness: ClaudeCodeCredentialFreshness,
  source: ClaudeCodeCredentialComparatorSource,
) {
  return {
    source,
    hasAccessToken: payload.claudeAiOauth.accessToken.length > 0,
    hasRefreshToken: typeof payload.claudeAiOauth.refreshToken === 'string' && payload.claudeAiOauth.refreshToken.length > 0,
    accessTokenFingerprint: computeClaudeCodeCredentialSafeTokenFingerprint(payload.claudeAiOauth.accessToken),
    refreshTokenFingerprint: payload.claudeAiOauth.refreshToken
      ? computeClaudeCodeCredentialSafeTokenFingerprint(payload.claudeAiOauth.refreshToken)
      : null,
    expiresAtMs: freshness.expiresAt,
    updatedAtMs: freshness.updatedAtMs,
  };
}
