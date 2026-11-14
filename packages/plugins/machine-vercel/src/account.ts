import { PluginError, type PluginAccountApi } from '@happier-dev/plugin-sdk';
import type {
  ConnectedAccountAuthCompletionResult, ConnectedAccountAuthenticationContext,
  ConnectedAccountHealthResult, ConnectedAccountMaterialization, ConnectedAccountMaterializationRequest,
  ConnectedAccountPortableReadContext, ConnectedAccountPortableRuntime, ConnectedAccountReadContext, ConnectedAccountRuntime,
  PluginConnectedAccountConfigurationFieldV2,
} from '@happier-dev/plugin-sdk/connected-accounts';
import type { HttpResponse } from '@happier-dev/plugin-sdk/http';

export const ACCOUNT_ID = 'vercel-account';
const origin = 'https://api.vercel.com';
type Context = Pick<ConnectedAccountAuthenticationContext, 'signal' | 'configuration' | 'services'>;
type Scope = Readonly<{ teamId: string; projectId?: string }>;
type ProbeResult = Extract<ConnectedAccountAuthCompletionResult, { status: 'connected' | 'rejected' | 'unavailable' }>;
type Failure = Exclude<ProbeResult, { status: 'connected' }>;
type TeamChoice = Readonly<{ id: string; name: string }>;

function diagnostic(code: string, message: string) {
  return { code, severity: 'error' as const, message };
}

function unexpectedResponse() {
  return { status: 'unavailable' as const, diagnostic: diagnostic('vercel_invalid_response', 'Vercel returned an unexpected response. Try connecting again; if it continues, check the Vercel service status.') };
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
    throw new PluginError({ code: 'vercel_invalid_response' });
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

function transportFailure(error: unknown, signal: AbortSignal): Failure {
  signal.throwIfAborted();
  if (error instanceof PluginError && error.code === 'vercel_invalid_response') return unexpectedResponse();
  return { status: 'unavailable', diagnostic: diagnostic('vercel_unavailable', 'Vercel could not be reached. Try the connection again.') };
}

function invalidToken(response: HttpResponse, body: unknown): boolean {
  return response.status === 401 || (response.status === 403 && object(body) && object(body.error) && body.error.invalidToken === true);
}

function responseFailure(response: HttpResponse, body: unknown): Failure | null {
  if (invalidToken(response, body)) {
    return { status: 'rejected', diagnostic: diagnostic('vercel_invalid_token', 'The Vercel token is invalid, expired or revoked. Create a new personal access token.') };
  }
  if (response.status === 403) return { status: 'rejected', diagnostic: diagnostic('vercel_missing_permission', 'The Vercel token cannot access the selected scope. Check its team and project access.') };
  if (response.status === 404) return { status: 'rejected', diagnostic: diagnostic('vercel_scope_unavailable', 'The selected Vercel team or project is unavailable to this token.') };
  if (response.status === 429 || response.status >= 500) return { status: 'unavailable', diagnostic: diagnostic('vercel_unavailable', 'Vercel is temporarily unavailable. Try connecting again.') };
  if (response.status !== 200) return unexpectedResponse();
  return null;
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
async function probe(token: string, scope: Scope | null, context: Context, signal: AbortSignal): Promise<ProbeResult> {
  signal.throwIfAborted();
  if (!scope) return { status: 'rejected', diagnostic: diagnostic('vercel_invalid_configuration', 'Choose a Vercel team and, for a project-scoped token, its project.') };
  const url = scope.projectId
    ? new URL(`${origin}/v9/projects/${encodeURIComponent(scope.projectId)}`)
    : new URL(`${origin}/v2/teams/${encodeURIComponent(scope.teamId)}`);
  if (scope.projectId) url.searchParams.set('teamId', scope.teamId);
  let response: HttpResponse;
  try { response = await send(context, token, url.href, 'GET', signal); }
  catch (error) { return transportFailure(error, signal); }
  const body = parseBody(response);
  const failure = responseFailure(response, body);
  if (failure) return failure;
  if (!object(body) || !identifier(body.id) || typeof body.name !== 'string' || !body.name.trim()
    || (scope.projectId && !identifier(body.accountId))) {
    return unexpectedResponse();
  }
  if (body.id !== (scope.projectId ?? scope.teamId) || (scope.projectId && body.accountId !== scope.teamId)) {
    return { status: 'rejected', diagnostic: diagnostic('vercel_scope_mismatch', 'Vercel returned a different team or project. Check the selected scope.') };
  }
  // A team can contain multiple independently scoped connections. The host
  // mints their account identity; organizationId must not become its KV key.
  return { status: 'connected', displayName: body.name,
    providerIdentity: { accountId: null, email: null, organizationId: scope.teamId }, scopes: [] };
}

/**
 * Official GET /v2/teams, checked 2026-11-14:
 * https://vercel.com/docs/rest-api/teams/list-all-teams
 * Pages continue with until=pagination.next until next is null. Project
 * tokens deny team-level resources, so a non-token 403 means "cannot list".
 */
async function listTeams(token: string, context: Context, signal: AbortSignal): Promise<readonly TeamChoice[] | 'unlisted' | Failure> {
  const teams = new Map<string, TeamChoice>();
  let until: string | null = null;
  for (;;) {
    const url = new URL(`${origin}/v2/teams`);
    if (until !== null) url.searchParams.set('until', until);
    let response: HttpResponse;
    try { response = await send(context, token, url.href, 'GET', signal); }
    catch (error) { return transportFailure(error, signal); }
    const body = parseBody(response);
    if (response.status === 403 && !invalidToken(response, body)) return 'unlisted';
    const failure = responseFailure(response, body);
    if (failure) return failure;
    if (!object(body) || !Array.isArray(body.teams) || !object(body.pagination)) return unexpectedResponse();
    for (const team of body.teams) {
      if (!object(team) || !identifier(team.id) || typeof team.name !== 'string' || !team.name.trim()) return unexpectedResponse();
      teams.set(team.id, { id: team.id, name: team.name });
    }
    const next: unknown = body.pagination.next;
    if (next === null) return [...teams.values()];
    const cursor = typeof next === 'number' && Number.isSafeInteger(next) ? String(next)
      : typeof next === 'string' && /^\d+$/u.test(next) ? next : null;
    // A cursor that does not advance would page forever.
    if (cursor === null || cursor === until) return unexpectedResponse();
    until = cursor;
  }
}

function teamField(teams: readonly TeamChoice[]): PluginConnectedAccountConfigurationFieldV2 {
  return { id: 'teamId', title: 'Vercel team', required: true, secret: false,
    schema: { type: 'string', enum: teams.map(team => team.id) },
    presentation: { order: 1, options: teams.map(team => ({ value: team.id, title: team.name })) } };
}

/** Project tokens cannot list teams; their exact team and project stay typed. */
const unlistedScopeFields: readonly PluginConnectedAccountConfigurationFieldV2[] = [
  { id: 'teamId', title: 'Team ID', required: true, secret: false, schema: { type: 'string', minLength: 1 },
    description: 'This token cannot list your Vercel teams, which usually means it is scoped to one project. Enter the team ID from the team settings.',
    presentation: { placeholder: 'team_…', order: 1 } },
  { id: 'projectId', title: 'Project ID', required: false, secret: false, schema: { type: 'string', minLength: 1 },
    description: 'For a project-scoped token, enter that project\'s ID from its settings.',
    presentation: { placeholder: 'prj_…', order: 2 } },
];

async function stageToken(context: ConnectedAccountAuthenticationContext, token: string, signal: AbortSignal): Promise<Failure | null> {
  signal.throwIfAborted();
  try { await context.attemptCredentials.set('token', token, { signal }); }
  catch {
    signal.throwIfAborted();
    return { status: 'unavailable', diagnostic: diagnostic('vercel_credential_storage_unavailable', 'The verified Vercel token could not be staged. Try the connection again.') };
  }
  signal.throwIfAborted();
  return null;
}

/**
 * Without a configured team, the pasted token offers its teams. The host keeps
 * the token in this attempt's temporary custody until the chosen team's exact
 * probe in reconcile connects; a single team is chosen in place.
 */
async function discover(token: string, context: ConnectedAccountAuthenticationContext, signal: AbortSignal): Promise<ConnectedAccountAuthCompletionResult> {
  const listed = await listTeams(token, context, signal);
  if (listed !== 'unlisted' && 'status' in listed) return listed;
  const teams = listed === 'unlisted' ? [] : listed;
  const only = teams.length === 1 ? teams[0]! : null;
  if (only && context.stageAccountConfiguration) {
    const scope = scopeOf({ configuration: { ...context.configuration, values: { ...context.configuration.values, teamId: only.id } } });
    const result = await probe(token, scope, context, signal);
    if (result.status !== 'connected') return result;
    try {
      await context.stageAccountConfiguration({ fields: [teamField(teams)],
        values: { ...context.configuration.values, teamId: only.id } });
    } catch {
      signal.throwIfAborted();
      return { status: 'unavailable', diagnostic: diagnostic('vercel_configuration_unavailable', 'The Vercel team could not be saved. Try the connection again.') };
    }
    return await stageToken(context, token, signal) ?? result;
  }
  const staged = await stageToken(context, token, signal);
  if (staged) return staged;
  return { status: 'configurationRequired',
    fields: teams.length > 0 ? [teamField(teams)] : unlistedScopeFields };
}

async function health(context: ConnectedAccountReadContext, options?: { signal?: AbortSignal }): Promise<ConnectedAccountHealthResult> {
  const signal = operationSignal(context, options?.signal);
  signal.throwIfAborted();
  try {
    const token = await context.credentials.get('token', { signal });
    signal.throwIfAborted();
    if (!validToken(token)) return { status: 'reconnectRequired', diagnostic: diagnostic('vercel_invalid_token', 'Reconnect Vercel with a personal access token.') };
    const result = await probe(token, scopeOf(context), context, signal);
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
    if (context.configuration.values.teamId === undefined) return await discover(token, context, signal);
    const result = await probe(token, scopeOf(context), context, signal);
    if (result.status !== 'connected') return result;
    return await stageToken(context, token, signal) ?? result;
  },
  // Continues a discovered team choice with the token already staged in this attempt.
  async reconcile(context, options) {
    const signal = operationSignal(context, options?.signal);
    signal.throwIfAborted();
    let token: string | null;
    try { token = await context.attemptCredentials.get('token', { signal }); }
    catch {
      signal.throwIfAborted();
      return { status: 'unavailable', diagnostic: diagnostic('vercel_credential_storage_unavailable', 'The Vercel token could not be read from this connection attempt. Try the connection again.') };
    }
    if (!validToken(token)) return { status: 'rejected', diagnostic: diagnostic('vercel_invalid_token', 'Paste the Vercel access token again.') };
    return await probe(token, scopeOf(context), context, signal);
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
