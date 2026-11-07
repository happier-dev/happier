import { PluginError, type PluginAccountApi } from '@happier-dev/plugin-sdk';
import type {
  ConnectedAccountAuthCompletionResult, ConnectedAccountAuthenticationContext,
  ConnectedAccountHealthResult, ConnectedAccountMaterialization, ConnectedAccountMaterializationRequest,
  ConnectedAccountPortableReadContext, ConnectedAccountPortableRuntime, ConnectedAccountReadContext, ConnectedAccountRuntime,
} from '@happier-dev/plugin-sdk/connected-accounts';
import type { HttpResponse } from '@happier-dev/plugin-sdk/http';

export const ACCOUNT_ID = 'vercel-account';
const origin = 'https://api.vercel.com';
type Context = Pick<ConnectedAccountAuthenticationContext, 'signal' | 'configuration' | 'services'>;
type Scope = Readonly<{ teamId: string; projectId?: string }>;
type ProbeResult = Extract<ConnectedAccountAuthCompletionResult, { status: 'connected' | 'rejected' | 'unavailable' }>;

function diagnostic(code: string, message: string) {
  return { code, severity: 'error' as const, message };
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !/\s/u.test(value)
    && value !== '.' && value !== '..';
}

function scopeOf(context: Pick<Context, 'configuration'>): Scope | null {
  const { teamId, projectId } = context.configuration.values;
  if (!identifier(teamId) || (projectId !== undefined && !identifier(projectId))) return null;
  return { teamId, ...(typeof projectId === 'string' ? { projectId } : {}) };
}

function validToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/\s/u.test(value);
}

function operationSignal(context: Pick<Context, 'signal'>, signal?: AbortSignal) {
  return signal ? AbortSignal.any([context.signal, signal]) : context.signal;
}

async function send(context: Context, token: string, url: string, method: 'GET' | 'DELETE', signal: AbortSignal) {
  signal.throwIfAborted();
  const response = await context.services.http.request({ url, method,
    headers: { authorization: `Bearer ${token}` }, redirect: 'error' }, { signal });
  signal.throwIfAborted();
  if (response.finalUrl !== url || (response.status >= 300 && response.status < 400)) {
    throw new Error('vercel_unavailable');
  }
  return response;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseBody(response: HttpResponse): unknown {
  try { return JSON.parse(new TextDecoder().decode(response.body)); }
  catch { return null; }
}

/**
 * Official REST v9 project / v2 team schemas, checked 2026-10-27:
 * https://vercel.com/docs/rest-api/projects/find-a-project-by-id-or-name
 * https://vercel.com/docs/rest-api/teams/get-a-team
 *
 * https://vercel.com/docs/accounts/access-tokens documents team/project PAT
 * read/write scope. This read proves authentication and exact scope identity,
 * not every actor's write permission. Hence no inferred permission scopes.
 * Project PATs deny user/team resources: never require a broader metadata read.
 */
async function probe(token: string, context: Context, signal: AbortSignal): Promise<ProbeResult> {
  signal.throwIfAborted();
  const scope = scopeOf(context);
  if (!scope) return { status: 'rejected', diagnostic: diagnostic('vercel_invalid_configuration', 'Choose a Vercel team and, for a project-scoped token, its project.') };
  const url = scope.projectId
    ? new URL(`${origin}/v9/projects/${encodeURIComponent(scope.projectId)}`)
    : new URL(`${origin}/v2/teams/${encodeURIComponent(scope.teamId)}`);
  if (scope.projectId) url.searchParams.set('teamId', scope.teamId);
  let response: HttpResponse;
  try { response = await send(context, token, url.href, 'GET', signal); }
  catch {
    signal.throwIfAborted();
    return { status: 'unavailable', diagnostic: diagnostic('vercel_unavailable', 'Vercel could not be reached. Try the connection again.') };
  }
  const body = parseBody(response);
  if (response.status === 401 || (response.status === 403 && object(body) && object(body.error) && body.error.invalidToken === true)) {
    return { status: 'rejected', diagnostic: diagnostic('vercel_invalid_token', 'The Vercel token is invalid, expired or revoked. Create a new personal access token.') };
  }
  if (response.status === 403) return { status: 'rejected', diagnostic: diagnostic('vercel_missing_permission', 'The Vercel token cannot access the selected scope. Check its team and project access.') };
  if (response.status === 404) return { status: 'rejected', diagnostic: diagnostic('vercel_scope_unavailable', 'The selected Vercel team or project is unavailable to this token.') };
  if (response.status !== 200) return { status: 'unavailable', diagnostic: diagnostic('vercel_unavailable', 'Vercel could not verify the selected scope. Try the connection again.') };
  if (!object(body) || !identifier(body.id) || typeof body.name !== 'string' || !body.name.trim()
    || (scope.projectId && !identifier(body.accountId))) {
    return { status: 'unavailable', diagnostic: diagnostic('vercel_invalid_response', 'Vercel returned an unrecognized account response.') };
  }
  if (body.id !== (scope.projectId ?? scope.teamId) || (scope.projectId && body.accountId !== scope.teamId)) {
    return { status: 'rejected', diagnostic: diagnostic('vercel_scope_mismatch', 'Vercel returned a different team or project. Check the selected scope.') };
  }
  // A team can contain multiple independently scoped connections. The host
  // mints their account identity; organizationId must not become its KV key.
  return { status: 'connected', displayName: body.name,
    providerIdentity: { accountId: null, email: null, organizationId: scope.teamId }, scopes: [] };
}

async function health(context: ConnectedAccountReadContext, options?: { signal?: AbortSignal }): Promise<ConnectedAccountHealthResult> {
  const signal = operationSignal(context, options?.signal);
  signal.throwIfAborted();
  try {
    const token = await context.credentials.get('token', { signal });
    signal.throwIfAborted();
    if (!validToken(token)) return { status: 'reconnectRequired', diagnostic: diagnostic('vercel_invalid_token', 'Reconnect Vercel with a personal access token.') };
    const result = await probe(token, context, signal);
    return result.status === 'rejected' ? { status: 'reconnectRequired', diagnostic: result.diagnostic } : result;
  } catch {
    signal.throwIfAborted();
    return { status: 'unavailable', diagnostic: diagnostic('vercel_unavailable', 'The Vercel connection could not be checked.') };
  }
}

async function materialize(
  request: ConnectedAccountMaterializationRequest,
  context: ConnectedAccountPortableReadContext,
  options?: { signal?: AbortSignal },
): Promise<ConnectedAccountMaterialization> {
  const signal = operationSignal(context, options?.signal);
  signal.throwIfAborted();
  if (request.kind === 'environment') {
    const scope = scopeOf(context);
    if (!scope) throw new PluginError({ code: 'credential_unavailable' });
    const values: Readonly<Record<string, string | undefined>> = {
      VERCEL_TEAM_ID: scope.teamId, VERCEL_PROJECT_ID: scope.projectId,
    };
    const env: Record<string, string> = {};
    for (const key of request.keys) {
      const value = Object.hasOwn(values, key) ? values[key] : undefined;
      if (value === undefined) throw new PluginError({ code: 'credential_unavailable' });
      env[key] = value;
    }
    return { kind: 'environment', env };
  }
  if (request.kind !== 'httpHeaders' || request.origin !== origin
    || request.headerNames.some(name => name.toLowerCase() !== 'authorization')) throw new PluginError({ code: 'credential_unavailable' });
  if (request.headerNames.length === 0) return { kind: 'httpHeaders', headers: {} };
  try {
    const token = await context.credentials.get('token', { signal });
    signal.throwIfAborted();
    if (!validToken(token)) throw new PluginError({ code: 'credential_unavailable' });
    return { kind: 'httpHeaders', headers: { authorization: `Bearer ${token}` } };
  } catch {
    signal.throwIfAborted();
    throw new PluginError({ code: 'credential_unavailable' });
  }
}

export const connectedAccountRuntime: ConnectedAccountRuntime = {
  authentication: { modes: { token: { kind: 'manual', async complete(input, context, options) {
    const signal = operationSignal(context, options?.signal);
    signal.throwIfAborted();
    const supplied = input.fields.token;
    const token = supplied?.trim();
    if (typeof supplied !== 'string' || /[\r\n]/u.test(supplied) || !validToken(token)) {
      return { status: 'rejected', diagnostic: diagnostic('vercel_invalid_token', 'Enter a Vercel personal access token.') };
    }
    const result = await probe(token, context, signal);
    if (result.status !== 'connected') return result;
    signal.throwIfAborted();
    try { await context.attemptCredentials.set('token', token, { signal }); }
    catch {
      signal.throwIfAborted();
      return { status: 'unavailable', diagnostic: diagnostic('vercel_credential_storage_unavailable', 'The verified Vercel token could not be staged. Try the connection again.') };
    }
    signal.throwIfAborted();
    return result;
  } } } },
  status: health,
  // Personal tokens do not rotate: the existing host refresh operation probes
  // the retained token; an expired/revoked token requires explicit reconnect.
  refresh: health,
  async revoke(context, options) {
    const signal = operationSignal(context, options?.signal);
    signal.throwIfAborted();
    const manual = { status: 'remoteUnsupported' as const, diagnostic: diagnostic('vercel_manual_revoke_required', 'Revoke this token at https://vercel.com/account/tokens. Project-scoped tokens may not manage user tokens.') };
    try {
      const token = await context.credentials.get('token', { signal });
      signal.throwIfAborted();
      if (!validToken(token)) return manual;
      // Official DELETE v3 token contract explicitly supports "current".
      // https://vercel.com/docs/rest-api/authentication/delete-an-authentication-token
      const response = await send(context, token, `${origin}/v3/user/tokens/current`, 'DELETE', signal);
      const body = response.status === 200 ? parseBody(response) : null;
      if (response.status === 200 && object(body) && identifier(body.tokenId)) return { status: 'remoteRevoked' };
      if (response.status === 403) return { status: 'remoteUnsupported', diagnostic: diagnostic('vercel_missing_permission', 'This token cannot revoke itself. Revoke it at https://vercel.com/account/tokens.') };
      if ([400, 401, 404, 410].includes(response.status)) return manual;
    } catch { signal.throwIfAborted(); }
    return { status: 'outcomeUnknown', diagnostic: diagnostic('vercel_revocation_unknown', 'Vercel did not confirm token revocation. Check the token page before retrying.') };
  },
  materialize,
};

export const connectedAccountPortableRuntime: ConnectedAccountPortableRuntime = {
  authentication: connectedAccountRuntime.authentication,
  materialize,
};

/** Portable Account activation; native health and revocation keep their existing host. */
export function activate(api: PluginAccountApi): void {
  api.connectedAccounts.register(ACCOUNT_ID, connectedAccountPortableRuntime);
}
