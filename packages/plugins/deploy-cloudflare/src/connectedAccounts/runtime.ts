import { PluginError } from '@happier-dev/plugin-sdk';
import { isPluginError, projectActionFailureCauseV1, withActionFailureDiagnostic } from '@happier-dev/plugin-sdk/errors';
import type { ConnectedAccountAuthenticationContext, ConnectedAccountAuthenticationModeRuntime, ConnectedAccountHealthResult, ConnectedAccountMaterialization, ConnectedAccountPortableRuntime, ConnectedAccountReadContext, ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { CLOUDFLARE_API_ORIGIN, diagnostic, validToken, verifyCloudflareToken } from './probe.js';
import { cloudflareOAuthMode, cloudflareOAuthStatus, refreshCloudflareOAuth, revokeCloudflareOAuth } from './oauth.js';
import { readCloudflareQuota } from './quota.js';

export const CLOUDFLARE_ACCOUNT_ID = 'cloudflare';
type Context = ConnectedAccountAuthenticationContext | ConnectedAccountReadContext;

function operationSignal(context: Pick<Context, 'signal'>, signal?: AbortSignal) {
  return signal ? AbortSignal.any([context.signal, signal]) : context.signal;
}

async function health(context: ConnectedAccountReadContext, options?: { signal?: AbortSignal }): Promise<ConnectedAccountHealthResult> {
  if (context.configuration.target.modeId === 'oauth') return cloudflareOAuthStatus(context, options);
  const signal = operationSignal(context, options?.signal);
  signal.throwIfAborted();
  try {
    const token = await context.credentials.get('token', { signal });
    const expiry = await context.credentials.get('expiresAtMs', { signal });
    signal.throwIfAborted();
    if (!validToken(token) || (expiry !== null && !Number.isFinite(Number(expiry)))) return { status: 'reconnectRequired', diagnostic: diagnostic('cloudflare_token_rejected', 'Reconnect Cloudflare with a verified account token.') };
    if (expiry !== null && Number(expiry) <= Date.now()) return { status: 'expired' };
    const result = await verifyCloudflareToken(token, context, signal);
    return result.status === 'verified' ? result.identity
      : result.status === 'rejected' ? { status: 'reconnectRequired', diagnostic: result.diagnostic } : result;
  } catch (error) {
    signal.throwIfAborted();
    const failureCause = projectActionFailureCauseV1(error, 'cloudflare.health', { allowUnknownErrorCode: isPluginError(error) });
    return withActionFailureDiagnostic({ status: 'unavailable', diagnostic: {
      ...diagnostic(failureCause.errorCode ?? 'action_failed', 'The Cloudflare connection could not be checked. Check this device’s credential storage and network access, then reconnect.'),
      details: { failureCause },
    } }, { phase: 'cloudflare.health', causeKind: 'native_failure', error: new Error(failureCause.errorClass) });
  }
}

function manualMode(): Extract<ConnectedAccountAuthenticationModeRuntime, { kind: 'manual' }> {
  return { kind: 'manual' as const, async complete(input, context, options) {
    const signal = operationSignal(context, options?.signal);
    signal.throwIfAborted();
    const supplied = input.fields.token;
    const token = supplied?.trim();
    if (typeof supplied !== 'string' || /[\r\n]/u.test(supplied) || !validToken(token)) return { status: 'rejected' as const, diagnostic: diagnostic('cloudflare_token_rejected', 'Enter the Cloudflare API token for this connection mode.') };
    const result = await verifyCloudflareToken(token, context, signal);
    if (result.status !== 'verified') return result;
    signal.throwIfAborted();
    await context.attemptCredentials.set('token', token, { signal });
    await context.attemptCredentials.set('accountId', result.accountId, { signal });
    await context.attemptCredentials.set('scopes', JSON.stringify(result.identity.scopes), { signal });
    if (result.expiresAtMs !== undefined) await context.attemptCredentials.set('expiresAtMs', String(result.expiresAtMs), { signal });
    signal.throwIfAborted();
    return result.identity;
  } };
}

export const materializeCloudflareAccount: NonNullable<ConnectedAccountPortableRuntime['materialize']> = async (request, context, options): Promise<ConnectedAccountMaterialization> => {
  const signal = operationSignal(context, options?.signal);
  signal.throwIfAborted();
  if (request.kind !== 'httpHeaders' || request.origin !== CLOUDFLARE_API_ORIGIN
    || request.headerNames.some(name => name.toLowerCase() !== 'authorization')) throw new PluginError({ code: 'credential_unavailable' });
  if (request.headerNames.length === 0) return { kind: 'httpHeaders', headers: {} };
  const token = await context.credentials.get('token', { signal });
  const expiry = await context.credentials.get('expiresAtMs', { signal });
  signal.throwIfAborted();
  if (!validToken(token) || (expiry !== null && (!Number.isFinite(Number(expiry)) || Number(expiry) <= Date.now()))) throw new PluginError({ code: 'credential_unavailable' });
  return { kind: 'httpHeaders', headers: { authorization: `Bearer ${token}` } };
};

export const cloudflareConnectedAccountRuntime: ConnectedAccountRuntime = {
  authentication: { modes: { token: manualMode(), oauth: cloudflareOAuthMode } },
  status: health,
  quota: readCloudflareQuota,
  // Manual tokens do not rotate. The host's existing refresh lifecycle checks
  // current authority; expiry/revocation requires an explicit replacement.
  async refresh(context, options) {
    if (context.configuration.target.modeId === 'oauth') return refreshCloudflareOAuth(context, options);
    const result = await health(context, options);
    return result.status === 'expired'
      ? { status: 'reconnectRequired', diagnostic: diagnostic('cloudflare_token_rejected', 'This manual token has expired. Reconnect Cloudflare with a new token.') }
      : result;
  },
  async revoke(context, options) {
    if (context.configuration.target.modeId === 'oauth') return revokeCloudflareOAuth(context, options);
    operationSignal(context, options?.signal).throwIfAborted();
    const page = context.configuration.values.tokenOwner === 'account' ? 'https://dash.cloudflare.com/?to=/:account/api-tokens' : 'https://dash.cloudflare.com/profile/api-tokens';
    return { status: 'remoteUnsupported', diagnostic: diagnostic('cloudflare_manual_revoke_required', `Revoke the token at ${page}. This connection does not manage API tokens.`) };
  },
  materialize: materializeCloudflareAccount,
};
