import { PluginError } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountAuthenticationContext, ConnectedAccountAuthenticationModeRuntime, ConnectedAccountHealthResult, ConnectedAccountMaterialization, ConnectedAccountPortableRuntime, ConnectedAccountReadContext, ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { CLOUDFLARE_API_ORIGIN, diagnostic, validToken, verifyCloudflareToken } from './probe.js';
import { cloudflareOAuthMode, cloudflareOAuthStatus, refreshCloudflareOAuth, revokeCloudflareOAuth } from './oauth.js';

export const CLOUDFLARE_ACCOUNT_ID = 'cloudflare';
type Context = ConnectedAccountAuthenticationContext | ConnectedAccountReadContext;

function operationSignal(context: Pick<Context, 'signal'>, signal?: AbortSignal) {
  return signal ? AbortSignal.any([context.signal, signal]) : context.signal;
}

function productOf(context: Context): 'workers' | 'pages' | 'tunnel' | null {
  const { modeId } = context.configuration.target;
  return modeId === 'workers-token' ? 'workers' : modeId === 'pages-token' ? 'pages' : modeId === 'tunnel-token' ? 'tunnel' : null;
}

async function health(context: ConnectedAccountReadContext, options?: { signal?: AbortSignal }): Promise<ConnectedAccountHealthResult> {
  if (context.configuration.target.modeId.endsWith('-oauth')) return cloudflareOAuthStatus(context, options);
  const signal = operationSignal(context, options?.signal);
  signal.throwIfAborted();
  try {
    const token = await context.credentials.get('token', { signal });
    const expiry = await context.credentials.get('expiresAtMs', { signal });
    signal.throwIfAborted();
    if (!validToken(token) || (expiry !== null && !Number.isFinite(Number(expiry)))) return { status: 'reconnectRequired', diagnostic: diagnostic('cloudflare_token_rejected', 'Reconnect Cloudflare with a verified account token.') };
    if (expiry !== null && Number(expiry) <= Date.now()) return { status: 'expired' };
    const product = productOf(context);
    if (!product) return { status: 'reconnectRequired', diagnostic: diagnostic('cloudflare_invalid_configuration', 'Reconnect with a supported Cloudflare product.') };
    const result = await verifyCloudflareToken(token, product, context, signal);
    return result.status === 'verified' ? result.identity
      : result.status === 'rejected' ? { status: 'reconnectRequired', diagnostic: result.diagnostic } : result;
  } catch {
    signal.throwIfAborted();
    return { status: 'unavailable', diagnostic: diagnostic('cloudflare_verification_unavailable', 'The Cloudflare connection could not be checked.') };
  }
}

function manualMode(product: 'workers' | 'pages' | 'tunnel'): Extract<ConnectedAccountAuthenticationModeRuntime, { kind: 'manual' }> {
  return { kind: 'manual' as const, async complete(input, context, options) {
    const signal = operationSignal(context, options?.signal);
    signal.throwIfAborted();
    const supplied = input.fields.token;
    const token = supplied?.trim();
    if (typeof supplied !== 'string' || /[\r\n]/u.test(supplied) || !validToken(token)) return { status: 'rejected' as const, diagnostic: diagnostic('cloudflare_token_rejected', 'Enter the Cloudflare API token for this connection mode.') };
    const result = await verifyCloudflareToken(token, product, context, signal);
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
  authentication: { modes: { 'workers-token': manualMode('workers'), 'pages-token': manualMode('pages'),
    'tunnel-token': manualMode('tunnel'),
    'workers-oauth': cloudflareOAuthMode, 'pages-oauth': cloudflareOAuthMode } },
  status: health,
  // Manual tokens do not rotate. The host's existing refresh lifecycle checks
  // current authority; expiry/revocation requires an explicit replacement.
  async refresh(context, options) {
    if (context.configuration.target.modeId.endsWith('-oauth')) return refreshCloudflareOAuth(context, options);
    const result = await health(context, options);
    return result.status === 'expired'
      ? { status: 'reconnectRequired', diagnostic: diagnostic('cloudflare_token_rejected', 'This manual token has expired. Reconnect Cloudflare with a new token.') }
      : result;
  },
  async revoke(context, options) {
    if (context.configuration.target.modeId.endsWith('-oauth')) return revokeCloudflareOAuth(context, options);
    operationSignal(context, options?.signal).throwIfAborted();
    const page = productOf(context) === 'pages' ? 'https://dash.cloudflare.com/?to=/:account/api-tokens' : 'https://dash.cloudflare.com/profile/api-tokens';
    return { status: 'remoteUnsupported', diagnostic: diagnostic('cloudflare_manual_revoke_required', `Revoke the token at ${page}. This deployment connection has read-only token-management access.`) };
  },
  materialize: materializeCloudflareAccount,
};
