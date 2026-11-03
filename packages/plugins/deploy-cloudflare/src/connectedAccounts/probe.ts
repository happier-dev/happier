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

function missingPermissions(): Failure {
  return { status: 'rejected', diagnostic: diagnostic('cloudflare_missing_permissions', 'The token does not prove all required permissions for this account. Check the permission checklist and token resource scope.') };
}

class ProbeFailure extends Error {
  constructor(readonly result: Failure) { super(result.diagnostic.code); }
}

async function read(context: Context, token: string, path: string, signal: AbortSignal, verification = false): Promise<unknown> {
  signal.throwIfAborted();
  const url = `${CLOUDFLARE_API_ORIGIN}/client/v4${path}`;
  const response = await context.services.http.request({ url, method: 'GET', headers: { authorization: `Bearer ${token}` }, redirect: 'error' }, { signal });
  signal.throwIfAborted();
  if (response.status >= 300 && response.status < 400) throw new Error('Unexpected Cloudflare redirect');
  if (response.status === 401 || (verification && response.status === 403)) {
    throw new ProbeFailure({ status: 'rejected', diagnostic: diagnostic('cloudflare_token_rejected', 'The Cloudflare token is invalid, expired or revoked.') });
  }
  if (response.status === 403 || response.status === 404) throw new ProbeFailure(missingPermissions());
  if (response.status !== 200) throw new Error('Cloudflare verification unavailable');
  const body: unknown = JSON.parse(new TextDecoder().decode(response.body));
  if (!isObject(body) || body.success !== true || !('result' in body)) throw new Error('Invalid Cloudflare response');
  return body.result;
}

/**
 * User/account-owned token policy contract, checked 2026-10-27:
 * https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/get/
 * https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/
 * Resolve provider permission IDs from its catalog, then check those IDs and
 * resources together in the SAME policy. Nested zone grants do not grant
 * account-wide deployment rights. Relevant deny or unknown policy shapes refuse.
 */
function grantsResourcePermissions(policies: unknown, permissionIds: readonly string[], resource: Readonly<{ scope: string; id: string }>): boolean {
  if (!Array.isArray(policies) || policies.length === 0) return false;
  const allowed = new Set<string>();
  for (const policy of policies) {
    if (!isObject(policy) || (policy.effect !== 'allow' && policy.effect !== 'deny')
      || !Array.isArray(policy.permission_groups) || !isObject(policy.resources)) return false;
    const groups = policy.permission_groups;
    if (groups.some(group => !isObject(group) || !isCloudflareId(group.id))) return false;
    const relevantIds = permissionIds.filter(id => groups.some(group => isObject(group) && group.id === id));
    if (relevantIds.length === 0) continue;
    const resources = policy.resources;
    const matching = [resources[`${resource.scope}.${resource.id}`], resources[`${resource.scope}.*`]]
      .filter(value => value !== undefined);
    if (policy.effect === 'deny') {
      // A narrower or unknown deny cannot safely be promoted to a full grant.
      if (matching.length > 0 || '*' in resources) return false;
    } else if (matching.some(value => value === '*')) {
      for (const id of relevantIds) allowed.add(id);
    }
  }
  return permissionIds.every(id => allowed.has(id));
}

export async function verifyCloudflareToken(token: string, product: 'workers' | 'pages' | 'tunnel', context: Context, signal: AbortSignal): Promise<VerifiedCloudflareToken | Failure> {
  signal.throwIfAborted();
  const accountId = context.configuration.values.accountId;
  if (!isCloudflareId(accountId)) return { status: 'rejected', diagnostic: diagnostic('cloudflare_invalid_configuration', 'Enter the Cloudflare account ID shown in the account dashboard.') };
  const zoneId = context.configuration.values.zoneId;
  if (product === 'tunnel' && !isCloudflareId(zoneId)) return { status: 'rejected', diagnostic: diagnostic('cloudflare_invalid_configuration', 'Select the exact DNS zone for this tunnel connection.') };
  try {
    const base = `/accounts/${accountId}`;
    // The Builds API explicitly rejects account-owned API tokens. Workers uses
    // a user token; Pages keeps its supported account-owned token contract.
    // https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/
    const tokens = product === 'pages' ? `${base}/tokens` : '/user/tokens';
    const verified = await read(context, token, `${tokens}/verify`, signal, true);
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
    const details = await read(context, token, `${tokens}/${verified.id}`, signal);
    if (!isObject(details) || details.id !== verified.id || details.status !== 'active') return missingPermissions();
    // Scripts Write covers script/version/traffic/secret operations. Git builds
    // and their logs separately require CI Write; Pages Write covers its own
    // project/deployment/environment/domain/build-log operations.
    // https://developers.cloudflare.com/api/resources/workers_builds/subresources/triggers/methods/create_build/
    // Cloudflare v4 schema: tunnel configuration PUT accepts Cloudflare Tunnel
    // Write; DNS removal requires DNS Write. Resolve each scope separately.
    const names = product === 'workers' ? ['Workers Scripts Write', 'Workers CI Write']
      : product === 'tunnel' ? ['Cloudflare Tunnel Write', 'DNS Write'] : ['Pages Write'];
    const permissionIds: string[] = [];
    for (const name of names) {
      const scope = name === 'DNS Write' ? 'com.cloudflare.api.account.zone' : 'com.cloudflare.api.account';
      const query = `name=${encodeURIComponent(name)}&scope=${scope}`;
      const catalog = await read(context, token, `${tokens}/permission_groups?${query}`, signal);
      if (!Array.isArray(catalog)) throw new Error('Invalid permission catalog');
      const matches = catalog.filter(group => isObject(group) && group.name === name && isCloudflareId(group.id)
        && Array.isArray(group.scopes) && group.scopes.includes(scope));
      if (matches.length !== 1 || !isObject(matches[0]) || !isCloudflareId(matches[0].id)) return missingPermissions();
      permissionIds.push(matches[0].id);
      // The tunnel configuration boundary above established this zone id.
      if (!grantsResourcePermissions(details.policies, [matches[0].id], { scope, id: name === 'DNS Write' ? zoneId as string : accountId })) return missingPermissions();
    }
    if (product === 'tunnel') {
      // DNS Write permits this exact zone read; its Account identity avoids
      // requiring unrelated Account Settings or deployment permissions.
      const zone = await read(context, token, `/zones/${zoneId}`, signal);
      const identity = cloudflareZoneIdentity(zone, accountId, zoneId as string);
      if (!identity || !isObject(zone) || !isObject(zone.account)) return missingPermissions();
      return { status: 'verified', accountId, ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
        identity: { status: 'connected', displayName: typeof zone.account.name === 'string' ? zone.account.name : identity.name,
          providerIdentity: { accountId, email: null, organizationId: null }, scopes: permissionIds } };
    }
    const account = await read(context, token, base, signal);
    if (!isObject(account) || !isCloudflareId(account.id) || typeof account.name !== 'string' || !account.name.trim()) throw new Error('Invalid account identity');
    if (account.id !== accountId) return { status: 'rejected', diagnostic: diagnostic('cloudflare_account_mismatch', 'Cloudflare returned a different account. Check the selected account ID.') };
    return { status: 'verified', accountId, ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
      identity: { status: 'connected', displayName: account.name, providerIdentity: { accountId, email: null, organizationId: null }, scopes: permissionIds } };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ProbeFailure) return error.result;
    return { status: 'unavailable', diagnostic: diagnostic('cloudflare_verification_unavailable', 'Cloudflare could not verify this connection. No token was saved; try again.') };
  }
}
