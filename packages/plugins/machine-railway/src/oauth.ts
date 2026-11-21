import type {
  ConnectedAccountAuthCompletionResult,
  ConnectedAccountAuthenticationContext,
  ConnectedAccountAuthenticationModeRuntime,
  ConnectedAccountCredentialStore,
  ConnectedAccountHealthResult,
  ConnectedAccountReadContext,
  ConnectedAccountRuntime,
  PluginConnectedAccountConfigurationFieldV2,
} from '@happier-dev/plugin-sdk/connected-accounts';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import { createRailwayProjectOperations, RAILWAY_ORIGIN } from '@happier-dev/railway-api';
import { nativeFetch } from './requestAuth.js';

const tokenUrl = RAILWAY_ORIGIN + '/oauth/token';
type Context = ConnectedAccountAuthenticationContext | ConnectedAccountReadContext;
type Failure = Extract<ConnectedAccountAuthCompletionResult, { status: 'rejected' | 'unavailable' | 'outcomeUnknown' }>;
type Identity = { subject: string; displayName: string; email: string | null };
type Choice = { id: string; name: string };

function diagnostic(suffix: string, message: string) {
  return { code: 'railway_oauth_' + suffix, severity: 'error' as const, message };
}

const reconnect = { status: 'rejected', diagnostic: diagnostic('reconnect_required',
  'Railway rejected this sign-in. Reconnect the account.') } as const;
const unavailable = { status: 'unavailable', diagnostic: diagnostic('unavailable',
  'Railway could not verify this sign-in. Try again.') } as const;

class GrantFailure extends Error {
  constructor(readonly result: Failure) { super(result.diagnostic.code); }
}

function signalOf(context: Pick<Context, 'signal'>, options?: { signal?: AbortSignal }) {
  return options?.signal ? AbortSignal.any([context.signal, options.signal]) : context.signal;
}

function failure(error: unknown, signal: AbortSignal): Failure {
  signal.throwIfAborted();
  return error instanceof GrantFailure ? error.result : unavailable;
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value && !/\p{Cc}/u.test(value);
}

async function request(context: Context, input: HttpRequest, signal: AbortSignal) {
  signal.throwIfAborted();
  const response = await context.services.http.request(input, { signal });
  signal.throwIfAborted();
  if (response.finalUrl !== input.url || response.status >= 300 && response.status < 400) throw new Error('Unexpected OAuth redirect');
  return response;
}

function bodyOf(body: Uint8Array): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(body));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

async function identify(context: Context, token: string, signal: AbortSignal): Promise<Identity> {
  const response = await request(context, {
    url: RAILWAY_ORIGIN + '/oauth/me', method: 'GET', redirect: 'error', headers: { authorization: 'Bearer ' + token },
  }, signal);
  if (response.status === 401 || response.status === 403) throw new GrantFailure(reconnect);
  const body = response.status === 200 ? bodyOf(response.body) : null;
  if (!body || !text(body.sub)) throw new GrantFailure(unavailable);
  const email = text(body.email) ? body.email : null;
  return { subject: body.sub, displayName: (text(body.name) && body.name) || email || body.sub, email };
}

async function exchange(context: Context, form: URLSearchParams, signal: AbortSignal, previousRefresh?: string) {
  let response;
  try {
    response = await request(context, {
      url: tokenUrl, method: 'POST', redirect: 'error', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new TextEncoder().encode(form.toString()),
    }, signal);
  } catch {
    signal.throwIfAborted();
    // Railway may have spent the code or rotated the refresh grant before a reply was lost.
    throw new GrantFailure({ status: 'outcomeUnknown', diagnostic: diagnostic('exchange_unknown',
      'Railway did not confirm the sign-in. Reconnect before trying again.') });
  }
  if ([400, 401, 403].includes(response.status)) throw new GrantFailure(reconnect);
  if (response.status !== 200) throw new GrantFailure(unavailable);
  const body = bodyOf(response.body);
  if (!body || !text(body.access_token) || typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer'
    || typeof body.expires_in !== 'number' || !Number.isSafeInteger(body.expires_in) || body.expires_in <= 0) {
    throw new GrantFailure(reconnect);
  }
  // Railway may keep the previous refresh token valid when it issues no replacement.
  const refreshToken = body.refresh_token === undefined ? previousRefresh : body.refresh_token;
  if (!text(refreshToken)) throw new GrantFailure({ status: 'rejected', diagnostic: diagnostic('refresh_grant_missing',
    'Railway did not grant offline access. Reconnect, or connect with an access token.') });
  return { token: body.access_token, refreshToken, expiresAt: Date.now() + body.expires_in * 1_000 };
}

async function stage(store: ConnectedAccountCredentialStore, grant: Awaited<ReturnType<typeof exchange>>, signal: AbortSignal) {
  await store.set('token', grant.token, { signal });
  await store.set('refreshToken', grant.refreshToken, { signal });
  await store.set('expiresAtMs', String(grant.expiresAt), { signal });
}

async function retainedIdentity(store: Pick<ConnectedAccountCredentialStore, 'get'>, signal: AbortSignal): Promise<Identity> {
  const subject = await store.get('subject', { signal });
  const displayName = await store.get('displayName', { signal });
  const email = await store.get('email', { signal });
  if (!text(subject) || !text(displayName)) throw new GrantFailure(reconnect);
  return { subject, displayName, email };
}

function connected(identity: Identity, workspaceId: string | null, expiresAt: number) {
  return { status: 'connected' as const, expiresAt, displayName: identity.displayName, scopes: [],
    providerIdentity: { accountId: identity.subject, organizationId: workspaceId, email: identity.email } };
}

export const railwayOAuthFields = [
  { id: 'workspaceId', title: 'Railway workspace', schema: { type: 'string', minLength: 1 }, required: false, secret: false },
  { id: 'projectId', title: 'Railway project', schema: { type: 'string', minLength: 1 }, required: false, secret: false },
  { id: 'environmentId', title: 'Railway environment', schema: { type: 'string', minLength: 1 }, required: false, secret: false },
] as const satisfies readonly PluginConnectedAccountConfigurationFieldV2[];

function field(base: typeof railwayOAuthFields[number], choices: readonly Choice[]): PluginConnectedAccountConfigurationFieldV2 {
  return { ...base, required: true, schema: { ...base.schema, enum: choices.map(choice => choice.id) },
    presentation: { options: choices.map(choice => ({ value: choice.id, title: choice.name })) } };
}

async function selectConfiguration(context: ConnectedAccountAuthenticationContext, token: string, signal: AbortSignal) {
  const client = createRailwayProjectOperations(nativeFetch(context, token), signal);
  const [workspaces, projectWorkspaces] = await Promise.all([client.listGrantedWorkspaces(), client.listGrantedProjectWorkspaces()]);
  const available = new Map([...projectWorkspaces, ...workspaces].map(workspace => [workspace.id, workspace]));
  if (available.size === 0) throw new GrantFailure({ status: 'rejected', diagnostic: diagnostic('no_workspaces',
    'Railway granted no workspaces or projects. Reconnect and share one on the consent screen.') });
  const { workspaceId, projectId, environmentId } = context.configuration.values;
  const workspace = text(workspaceId) ? available.get(workspaceId) : undefined;
  const [workspaceField, projectField, environmentField] = railwayOAuthFields;
  if (!workspace) return { status: 'configurationRequired' as const, fields: [field(workspaceField, [...available.values()])] };

  // An individually granted project must not expose projects the user did not grant.
  const projects = workspaces.some(choice => choice.id === workspace.id) ? await client.listProjects(workspace.id)
    : projectWorkspaces.find(choice => choice.id === workspace.id)?.projects ?? [];
  if (projects.length === 0) throw new GrantFailure({ status: 'rejected', diagnostic: diagnostic('no_projects',
    'The selected Railway workspace has no available projects. Reconnect and choose a project.') });
  const fixedWorkspace = field(workspaceField, [workspace]);
  const project = projects.find(choice => choice.id === projectId);
  if (!project) return { status: 'configurationRequired' as const, fields: [fixedWorkspace, field(projectField, projects)] };

  const environments = await client.listEnvironments(project.id);
  if (environments.length === 0) throw new GrantFailure({ status: 'rejected', diagnostic: diagnostic('no_environments',
    'The selected Railway project has no environments for Sandboxes.') });
  if (!environments.some(choice => choice.id === environmentId)) return { status: 'configurationRequired' as const,
    fields: [fixedWorkspace, field(projectField, [project]), field(environmentField, environments)] };
  return { status: 'chosen' as const, workspaceId: workspace.id };
}

export const railwayOAuthMode: Extract<ConnectedAccountAuthenticationModeRuntime, { kind: 'oauthAuthorizationCode' }> = {
  kind: 'oauthAuthorizationCode',
  async begin(input, context, options) {
    const signal = signalOf(context, options);
    try {
      const client = await context.configuration.getPublicOAuthClient?.({ signal });
      signal.throwIfAborted();
      if (!client) return { status: 'unavailable', diagnostic: diagnostic('public_client_unavailable',
        'This Home does not offer Sign in with Railway. Connect with an access token instead.') };
      if (input.pkce.method !== 'S256' || !input.pkce.challenge) return reconnect;
      await context.attemptCredentials.set('oauthClientId', client.clientId, { signal });
      const url = new URL(RAILWAY_ORIGIN + '/oauth/auth');
      url.search = new URLSearchParams({
        client_id: client.clientId, redirect_uri: input.callbackUrl, response_type: 'code', scope: client.scopes.join(' '),
        state: input.state, code_challenge: input.pkce.challenge, code_challenge_method: 'S256',
        // Railway requires consent on every authorization for offline access.
        prompt: 'consent',
      }).toString();
      return { status: 'awaitingOAuthRedirect', authorizationUrl: url.href, issuer: RAILWAY_ORIGIN };
    } catch (error) { return failure(error, signal); }
  },
  async complete(input, context, options) {
    const signal = signalOf(context, options);
    try {
      const store = context.attemptCredentials;
      const clientId = await store.get('oauthClientId', { signal });
      if (!text(clientId) || !input.pkceVerifier) return reconnect;
      const grant = await exchange(context, new URLSearchParams({
        grant_type: 'authorization_code', client_id: clientId, code: input.code,
        redirect_uri: input.callbackUrl, code_verifier: input.pkceVerifier,
      }), signal);
      const identity = await identify(context, grant.token, signal);
      const selection = await selectConfiguration(context, grant.token, signal);
      await stage(store, grant, signal);
      await store.set('subject', identity.subject, { signal });
      await store.set('displayName', identity.displayName, { signal });
      if (identity.email) await store.set('email', identity.email, { signal });
      return selection.status !== 'chosen' ? selection : connected(identity, selection.workspaceId, grant.expiresAt);
    } catch (error) { return failure(error, signal); }
  },
  async reconcile(context, options) {
    const signal = signalOf(context, options);
    try {
      const store = context.attemptCredentials;
      const token = await store.get('token', { signal });
      const expiresAt = Number(await store.get('expiresAtMs', { signal }));
      if (!text(token) || !(expiresAt > Date.now())) return reconnect;
      const selection = await selectConfiguration(context, token, signal);
      if (selection.status !== 'chosen') return selection;
      return connected(await retainedIdentity(store, signal), selection.workspaceId, expiresAt);
    } catch (error) { return failure(error, signal); }
  },
  async cancel() {},
};

export async function railwayOAuthStatus(context: ConnectedAccountReadContext, options?: { signal?: AbortSignal }): Promise<ConnectedAccountHealthResult> {
  const signal = signalOf(context, options);
  try {
    const expiresAt = Number(await context.credentials.get('expiresAtMs', { signal }));
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) return { ...reconnect, status: 'reconnectRequired' };
    if (expiresAt <= Date.now()) return { status: 'expired' };
    const token = await context.credentials.get('token', { signal });
    if (!text(token)) return { ...reconnect, status: 'reconnectRequired' };
    const workspaceId = context.configuration.values.workspaceId;
    return connected(await identify(context, token, signal), text(workspaceId) ? workspaceId : null, expiresAt);
  } catch (error) {
    const result = failure(error, signal);
    return { status: result.status === 'rejected' ? 'reconnectRequired' : 'unavailable', diagnostic: result.diagnostic };
  }
}

export const refreshRailwayOAuth: ConnectedAccountRuntime['refresh'] = async (context, options) => {
  const signal = signalOf(context, options);
  try {
    const clientId = await context.credentials.get('oauthClientId', { signal });
    const refreshToken = await context.credentials.get('refreshToken', { signal });
    if (!text(clientId) || !text(refreshToken)) throw new GrantFailure(reconnect);
    const identity = await retainedIdentity(context.credentials, signal);
    const grant = await exchange(context, new URLSearchParams({
      grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken,
    }), signal, refreshToken);
    await stage(context.stagedCredentials, grant, signal);
    const workspaceId = context.configuration.values.workspaceId;
    return connected(identity, text(workspaceId) ? workspaceId : null, grant.expiresAt);
  } catch (error) {
    const result = failure(error, signal);
    return result.status === 'rejected' ? { ...result, status: 'reconnectRequired' } : result;
  }
};

export const revokeRailwayOAuth: ConnectedAccountRuntime['revoke'] = async (context, options) => {
  signalOf(context, options).throwIfAborted();
  return { status: 'remoteUnsupported', diagnostic: diagnostic('manual_revoke_required',
    'To revoke Happier’s access, open Railway Account Settings → Apps → Revoke Access.') };
};
