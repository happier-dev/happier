import { PluginError } from '@happier-dev/plugin-sdk';
import { projectActionFailureCauseV1 } from '@happier-dev/plugin-sdk/errors';
import type {
  ConnectedAccountAuthCompletionResult, ConnectedAccountAuthenticationContext, PluginConnectedAccountConfigurationFieldV2,
} from '@happier-dev/plugin-sdk/connected-accounts';
import type { HttpResponse } from '@happier-dev/plugin-sdk/http';

/** Vercel REST probes and team discovery shared by the token and sign-in modes. */
export const origin = 'https://api.vercel.com';
export type Context = Pick<ConnectedAccountAuthenticationContext, 'signal' | 'configuration' | 'services'>;
export type Scope = Readonly<{ teamId: string; projectId?: string }>;
export type ProbeResult = Extract<ConnectedAccountAuthCompletionResult, { status: 'connected' | 'rejected' | 'unavailable' }>;
export type Failure = Exclude<ProbeResult, { status: 'connected' }>;
export type Choice = Readonly<{ id: string; name: string }>;

export function diagnostic(code: string, message: string) {
  return { code, severity: 'error' as const, message };
}

export function unexpectedResponse() {
  return { status: 'unavailable' as const, diagnostic: diagnostic('vercel_invalid_response', 'Vercel returned an unexpected response. Try connecting again; if it continues, check the Vercel service status.') };
}

export function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !/\s/u.test(value)
    && value !== '.' && value !== '..';
}

export function scopeOf(context: Pick<Context, 'configuration'>): Scope | null {
  const { teamId, projectId } = context.configuration.values;
  if (!identifier(teamId) || (projectId !== undefined && !identifier(projectId))) return null;
  return { teamId, ...(typeof projectId === 'string' ? { projectId } : {}) };
}

export function validToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/\s/u.test(value);
}

export function operationSignal(context: Pick<Context, 'signal'>, signal?: AbortSignal) {
  return signal ? AbortSignal.any([context.signal, signal]) : context.signal;
}

export async function send(context: Context, token: string, url: string, method: 'GET' | 'DELETE', signal: AbortSignal) {
  signal.throwIfAborted();
  const response = await context.services.http.request({ url, method,
    headers: { authorization: `Bearer ${token}` }, redirect: 'error' }, { signal });
  signal.throwIfAborted();
  if (response.finalUrl !== url || (response.status >= 300 && response.status < 400)) {
    throw new PluginError({ code: 'vercel_invalid_response' });
  }
  return response;
}

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseBody(response: HttpResponse): unknown {
  try { return JSON.parse(new TextDecoder().decode(response.body)); }
  catch { return null; }
}

export function transportFailure(error: unknown, signal: AbortSignal): Failure {
  signal.throwIfAborted();
  const result = error instanceof PluginError && error.code === 'vercel_invalid_response'
    ? unexpectedResponse()
    : { status: 'unavailable' as const, diagnostic: diagnostic('vercel_unavailable', 'Vercel could not be reached. Try the connection again.') };
  return { ...result, diagnostic: { ...result.diagnostic,
    details: { failureCause: projectActionFailureCauseV1(error, 'machine.account.probe') } } };
}

function invalidToken(response: HttpResponse, body: unknown): boolean {
  return response.status === 401 || (response.status === 403 && object(body) && object(body.error) && body.error.invalidToken === true);
}

/**
 * Vercel's refusal of a resource outside a token's granted scope:
 * `{ error: { code: 'forbidden', message: 'Not authorized: Trying to access resource under scope …' } }`.
 * For a sign-in it means the app's grant no longer covers the call.
 */
function scopeRefusal(response: HttpResponse, body: unknown): boolean {
  return response.status === 403 && object(body) && object(body.error) && body.error.code === 'forbidden'
    && typeof body.error.message === 'string' && /resource under scope/iu.test(body.error.message);
}

export function responseFailure(response: HttpResponse, body: unknown, signIn = false): Failure | null {
  if (invalidToken(response, body)) {
    return { status: 'rejected', diagnostic: diagnostic('vercel_invalid_token', 'The Vercel token is invalid, expired or revoked. Create a new personal access token.') };
  }
  if (signIn && scopeRefusal(response, body)) {
    return { status: 'rejected', diagnostic: diagnostic('vercel_permissions_update_required', 'Vercel needs updated permissions. Reconnect to review them.') };
  }
  if (response.status === 403) return { status: 'rejected', diagnostic: diagnostic('vercel_missing_permission', 'The Vercel token cannot access the selected scope. Check its team and project access.') };
  if (response.status === 404) return { status: 'rejected', diagnostic: diagnostic('vercel_scope_unavailable', 'The selected Vercel team or project is unavailable to this token.') };
  if (response.status === 429 || response.status >= 500) return { status: 'unavailable',
    ...(response.status === 429 ? { failureClass: 'rateLimit' as const } : {}),
    diagnostic: { ...diagnostic('vercel_unavailable', 'Vercel is temporarily unavailable. Try connecting again.'),
      details: { httpStatus: response.status,
        failureCause: projectActionFailureCauseV1({ status: response.status }, 'machine.account.probe') } } };
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
export async function probe(token: string, scope: Scope | null, context: Context, signal: AbortSignal, signIn = false): Promise<ProbeResult> {
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
  const failure = responseFailure(response, body, signIn);
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
 * Official GET /v2/teams (checked 2026-11-14) and GET /v10/projects (checked
 * 2026-11-18) share Vercel's REST pagination: pages continue with
 * until=pagination.next until next is null.
 * https://vercel.com/docs/rest-api/teams/list-all-teams
 * https://vercel.com/docs/rest-api/projects/retrieve-a-list-of-projects
 * Project tokens deny team-level resources, so a non-token 403 means "cannot list".
 */
async function listChoices(token: string, context: Context, signal: AbortSignal,
  path: '/v2/teams' | '/v10/projects', key: 'teams' | 'projects', parameters: Readonly<Record<string, string>> = {},
): Promise<readonly Choice[] | 'unlisted' | Failure> {
  const choices = new Map<string, Choice>();
  let until: string | null = null;
  for (;;) {
    const url = new URL(`${origin}${path}`);
    for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
    if (until !== null) url.searchParams.set('until', until);
    let response: HttpResponse;
    try { response = await send(context, token, url.href, 'GET', signal); }
    catch (error) { return transportFailure(error, signal); }
    const body = parseBody(response);
    if (response.status === 403 && !invalidToken(response, body)) return 'unlisted';
    const failure = responseFailure(response, body);
    if (failure) return failure;
    const items = object(body) ? body[key] : undefined;
    if (!object(body) || !Array.isArray(items) || !object(body.pagination)) return unexpectedResponse();
    for (const item of items) {
      if (!object(item) || !identifier(item.id) || typeof item.name !== 'string' || !item.name.trim()) return unexpectedResponse();
      choices.set(item.id, { id: item.id, name: item.name });
    }
    const next: unknown = body.pagination.next;
    if (next === null) return [...choices.values()];
    const cursor = typeof next === 'number' && Number.isSafeInteger(next) ? String(next)
      : typeof next === 'string' && /^\d+$/u.test(next) ? next : null;
    // A cursor that does not advance would page forever.
    if (cursor === null || cursor === until) return unexpectedResponse();
    until = cursor;
  }
}

export function listTeams(token: string, context: Context, signal: AbortSignal) {
  return listChoices(token, context, signal, '/v2/teams', 'teams');
}

export function listProjects(token: string, teamId: string, context: Context, signal: AbortSignal) {
  return listChoices(token, context, signal, '/v10/projects', 'projects', { teamId, limit: '100' });
}

export function teamField(teams: readonly Choice[]): PluginConnectedAccountConfigurationFieldV2 {
  return { id: 'teamId', title: 'Vercel team', required: true, secret: false,
    schema: { type: 'string', enum: teams.map(team => team.id) },
    presentation: { order: 1, options: teams.map(team => ({ value: team.id, title: team.name })) } };
}

/** Project tokens cannot list teams; their exact team and project stay typed. */
export const unlistedScopeFields: readonly PluginConnectedAccountConfigurationFieldV2[] = [
  { id: 'teamId', title: 'Team ID', required: true, secret: false, schema: { type: 'string', minLength: 1 },
    description: 'This token cannot list your Vercel teams, which usually means it is scoped to one project. Enter the team ID from the team settings.',
    presentation: { placeholder: 'team_…', order: 1 } },
  { id: 'projectId', title: 'Project ID', required: false, secret: false, schema: { type: 'string', minLength: 1 },
    description: 'For a project-scoped token, enter that project\'s ID from its settings.',
    presentation: { placeholder: 'prj_…', order: 2 } },
];

export async function stageToken(context: ConnectedAccountAuthenticationContext, token: string, signal: AbortSignal): Promise<Failure | null> {
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
export async function discover(token: string, context: ConnectedAccountAuthenticationContext, signal: AbortSignal): Promise<ConnectedAccountAuthCompletionResult> {
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
    } catch (error) {
      signal.throwIfAborted();
      // The host's staging refusal keeps its code-only cause; this plugin does not decide why staging failed.
      return { status: 'unavailable', diagnostic: { ...diagnostic('vercel_configuration_unavailable', 'The Vercel team could not be saved. Try the connection again.'),
        details: { failureCause: projectActionFailureCauseV1(error, 'machine.account.stage_configuration') } } };
    }
    return await stageToken(context, token, signal) ?? result;
  }
  const staged = await stageToken(context, token, signal);
  if (staged) return staged;
  return { status: 'configurationRequired',
    fields: teams.length > 0 ? [teamField(teams)] : unlistedScopeFields };
}
