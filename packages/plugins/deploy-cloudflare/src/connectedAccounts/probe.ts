import { cloudflareFeatureReadPaths, cloudflareFeatureNames } from './permissions.js';
import type { ConnectedAccountAuthCompletionResult, ConnectedAccountAuthenticationContext, ConnectedAccountReadContext } from '@happier-dev/plugin-sdk/connected-accounts';

export const CLOUDFLARE_API_ORIGIN = 'https://api.cloudflare.com';
type Context = ConnectedAccountAuthenticationContext | ConnectedAccountReadContext;
type Failure = Extract<ConnectedAccountAuthCompletionResult, { status: 'rejected' | 'unavailable' }>;
type Connected = Extract<ConnectedAccountAuthCompletionResult, { status: 'connected' }>;
export type VerifiedCloudflareToken = Readonly<{ status: 'verified'; identity: Connected; accountId: string; expiresAtMs?: number }>;

export function diagnostic(code: string, message: string) {
  return { code, severity: 'error' as const, message };
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isCloudflareId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{32}$/iu.test(value);
}

/** Exact zone identity shared by Connect verification and admitted zone reads. */
export function cloudflareZoneIdentity(value: unknown, accountId: string, zoneId: string): Readonly<{ accountId: string; zoneId: string; name: string }> | null {
  return isObject(value) && value.id === zoneId && typeof value.name === 'string' && value.name.trim()
    && isObject(value.account) && value.account.id === accountId
    ? { accountId, zoneId, name: value.name } : null;
}

export function validToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/\s/u.test(value);
}

function missingPermissions(message = 'Cloudflare refused access to the selected resource. Check the token access for this account or zone.'): Failure {
  return { status: 'rejected', diagnostic: diagnostic('cloudflare_missing_permissions', message) };
}

class ProbeFailure extends Error {
  constructor(readonly result: Failure) { super(result.diagnostic.code); }
}

async function read(context: Context, token: string, path: string, signal: AbortSignal, purpose: 'resource' | 'verification' = 'resource'): Promise<unknown> {
  signal.throwIfAborted();
  const url = `${CLOUDFLARE_API_ORIGIN}/client/v4${path}`;
  const response = await context.services.http.request({ url, method: 'GET', headers: { authorization: `Bearer ${token}` }, redirect: 'error' }, { signal });
  signal.throwIfAborted();
  if (response.status >= 300 && response.status < 400) throw new Error('Unexpected Cloudflare redirect');
  // Cloudflare reports a malformed Bearer token as 400 / 6003 → 6111.
  const verificationError: unknown = purpose === 'verification' && response.status === 400
    ? JSON.parse(new TextDecoder().decode(response.body)) : null;
  const invalidAuthorization = isObject(verificationError) && Array.isArray(verificationError.errors)
    && verificationError.errors.some(error => isObject(error) && error.code === 6003
      && Array.isArray(error.error_chain) && error.error_chain.some(cause => isObject(cause) && cause.code === 6111));
  if (response.status === 401 || (purpose === 'verification' && (response.status === 403 || invalidAuthorization))) {
    throw new ProbeFailure({ status: 'rejected', diagnostic: diagnostic('cloudflare_token_rejected', 'The Cloudflare token is invalid, expired or revoked.') });
  }
  if (response.status === 403 || response.status === 404) throw new ProbeFailure(missingPermissions());
  if (response.status !== 200) throw new Error('Cloudflare verification unavailable');
  const body: unknown = JSON.parse(new TextDecoder().decode(response.body));
  if (!isObject(body) || body.success !== true || !('result' in body)) throw new Error('Invalid Cloudflare response');
  return body.result;
}

export async function verifyCloudflareToken(token: string, context: Context, signal: AbortSignal): Promise<VerifiedCloudflareToken | Failure> {
  signal.throwIfAborted();
  const accountId = context.configuration.values.accountId;
  if (!isCloudflareId(accountId)) return { status: 'rejected', diagnostic: diagnostic('cloudflare_invalid_configuration', 'Enter the Cloudflare account ID shown in the account dashboard.') };
  const zoneId = context.configuration.values.zoneId;
  if (zoneId !== undefined && !isCloudflareId(zoneId)) return { status: 'rejected', diagnostic: diagnostic('cloudflare_invalid_configuration', 'Enter the exact DNS zone ID, or leave it empty when DNS is not needed.') };
  const tokenOwner = context.configuration.values.tokenOwner ?? 'user';
  if (tokenOwner !== 'user' && tokenOwner !== 'account') return { status: 'rejected', diagnostic: diagnostic('cloudflare_invalid_configuration', 'Choose whether the API token belongs to a user or account.') };
  const selected = context.configuration.values.features ?? (zoneId === undefined ? [] : ['DNS']);
  if (!Array.isArray(selected) || selected.some(feature => typeof feature !== 'string' || !cloudflareFeatureNames.includes(feature))) {
    return { status: 'rejected', diagnostic: diagnostic('cloudflare_invalid_configuration', 'Choose the Cloudflare features to check.') };
  }
  const features = cloudflareFeatureNames.filter(feature => selected.includes(feature));
  if (features.includes('DNS') && !isCloudflareId(zoneId)) return { status: 'rejected', diagnostic: diagnostic('cloudflare_invalid_configuration', 'Enter the selected DNS zone ID.') };
  if (tokenOwner === 'account' && features.includes('Workers')) return { status: 'rejected', diagnostic: diagnostic('cloudflare_invalid_configuration', 'Workers Builds requires a user-owned token.') };
  try {
    const base = `/accounts/${accountId}`;
    // The Builds API explicitly rejects account-owned API tokens. Workers uses
    // a user token; token ownership selects its documented verification endpoint.
    // https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/
    const tokens = tokenOwner === 'account' ? `${base}/tokens` : '/user/tokens';
    const verified = await read(context, token, `${tokens}/verify`, signal, 'verification');
    if (!isObject(verified) || !isCloudflareId(verified.id)) throw new Error('Invalid token verification');
    if (verified.status !== 'active') return { status: 'rejected', diagnostic: diagnostic('cloudflare_token_rejected', 'The Cloudflare token is not active. Create a new scoped token.') };
    let expiresAtMs: number | undefined;
    if (verified.expires_on !== undefined) {
      if (typeof verified.expires_on !== 'string' || !Number.isFinite(Date.parse(verified.expires_on))) throw new Error('Invalid token expiry');
      expiresAtMs = Date.parse(verified.expires_on);
      if (expiresAtMs <= Date.now()) return { status: 'rejected', diagnostic: diagnostic('cloudflare_token_rejected', 'The Cloudflare token has expired.') };
    }
    if (verified.not_before !== undefined && (typeof verified.not_before !== 'string' || !Number.isFinite(Date.parse(verified.not_before)) || Date.parse(verified.not_before) > Date.now())) {
      return { status: 'rejected', diagnostic: diagnostic('cloudflare_token_rejected', 'The Cloudflare token is not active yet.') };
    }
    // Account Details needs unrelated permissions for Pages, Tunnel and DNS tokens.
    // The configured account ID names the identity; selected reads establish access.
    // https://developers.cloudflare.com/api/resources/accounts/methods/get/
    // These finite reads establish only selected-resource readability. Cloudflare
    // remains the authority for deployment and other writes at their operation.
    // Cloudflare v4 scripts/projects/cloudflared list contracts checked 2026-11-04.
    for (const [feature, path] of Object.entries(cloudflareFeatureReadPaths)) {
      if (path !== null && features.includes(feature)) await read(context, token, `${base}${path}`, signal);
    }
    if (features.includes('DNS') && isCloudflareId(zoneId)) {
      const zone = await read(context, token, `/zones/${zoneId}`, signal);
      if (!cloudflareZoneIdentity(zone, accountId, zoneId)) return missingPermissions();
    }
    return { status: 'verified', accountId, ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
      identity: { status: 'connected', displayName: accountId, providerIdentity: { accountId, email: null, organizationId: null }, scopes: features } };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ProbeFailure) return error.result;
    return { status: 'unavailable', diagnostic: diagnostic('cloudflare_verification_unavailable', 'Cloudflare could not verify this connection. No token was saved; try again.') };
  }
}
