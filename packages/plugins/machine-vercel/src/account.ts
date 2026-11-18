import { PluginError, type PluginAccountApi } from '@happier-dev/plugin-sdk';
import { projectActionFailureCauseV1 } from '@happier-dev/plugin-sdk/errors';
import type {
  ConnectedAccountHealthResult, ConnectedAccountMaterialization, ConnectedAccountMaterializationRequest,
  ConnectedAccountPortableReadContext, ConnectedAccountPortableRuntime, ConnectedAccountReadContext, ConnectedAccountRuntime,
} from '@happier-dev/plugin-sdk/connected-accounts';
import { readVercelQuota } from './quota.js';
import { diagnostic, discover, identifier, object, operationSignal, origin, parseBody, probe, scopeOf, send, stageToken, validToken } from './probe.js';
import { refreshVercelOAuth, revokeVercelOAuth, vercelOAuthMode, vercelOAuthStatus } from './oauth.js';

export const ACCOUNT_ID = 'vercel-account';
async function health(context: ConnectedAccountReadContext, options?: { signal?: AbortSignal }): Promise<ConnectedAccountHealthResult> {
  const signal = operationSignal(context, options?.signal);
  signal.throwIfAborted();
  try {
    const token = await context.credentials.get('token', { signal });
    signal.throwIfAborted();
    if (!validToken(token)) return { status: 'reconnectRequired', diagnostic: diagnostic('vercel_invalid_token', 'Reconnect Vercel with a personal access token.') };
    const result = await probe(token, scopeOf(context), context, signal);
    return result.status === 'rejected' ? { status: 'reconnectRequired', diagnostic: result.diagnostic } : result;
  } catch (error) {
    signal.throwIfAborted();
    return { status: 'unavailable', diagnostic: {
      ...diagnostic('vercel_unavailable', 'The Vercel connection could not be checked.'),
      details: { failureCause: projectActionFailureCauseV1(error, 'machine.account.health') },
    } };
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
    // Only a sign-in grant expires; personal tokens carry no expiry here.
    const expiry = await context.credentials.get('expiresAtMs', { signal });
    signal.throwIfAborted();
    if (!validToken(token) || (expiry !== null && !(Number(expiry) > Date.now()))) throw new PluginError({ code: 'credential_unavailable' });
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
  } }, oauth: vercelOAuthMode } },
  status: (context, options) => context.configuration.target.modeId === 'oauth' ? vercelOAuthStatus(context, options) : health(context, options),
  quota: readVercelQuota,
  // Personal tokens do not rotate: the existing host refresh operation probes
  // the retained token; an expired/revoked token requires explicit reconnect.
  // A sign-in grant rotates through the refresh_token grant.
  refresh: (context, options) => context.configuration.target.modeId === 'oauth' ? refreshVercelOAuth(context, options) : health(context, options),
  async revoke(context, options) {
    if (context.configuration.target.modeId === 'oauth') return revokeVercelOAuth(context, options);
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
