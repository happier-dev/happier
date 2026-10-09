import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';

export const MODAL_ACCOUNT_ID = 'modal-account';
export const MODAL_ACCOUNT_PURPOSE = 'modal-credential';
export const MODAL_ENV_KEYS = ['MODAL_TOKEN_ID', 'MODAL_TOKEN_SECRET', 'MODAL_SERVER_URL', 'MODAL_ENVIRONMENT'] as const;
const tokenIdKey = 'tokenId';
const tokenSecretKey = 'tokenSecret';
const diagnostic = { code: 'modal_credential_unavailable', severity: 'error' as const,
  message: 'The selected Modal token or profile is unavailable. Reconnect this account.' };

async function profile(context: Parameters<ConnectedAccountRuntime['status']>[0]) {
  const tokenId = await context.credentials.get(tokenIdKey);
  const tokenSecret = await context.credentials.get(tokenSecretKey);
  const serverUrl = context.configuration.values.serverUrl;
  const environment = context.configuration.values.environment;
  if (!tokenId || !tokenSecret || typeof serverUrl !== 'string') return null;
  try {
    const endpoint = new URL(serverUrl);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
      || endpoint.pathname !== '/' || endpoint.search || endpoint.hash || endpoint.origin !== serverUrl) return null;
  } catch { return null; }
  if (environment !== undefined && typeof environment !== 'string') return null;
  return { MODAL_TOKEN_ID: tokenId, MODAL_TOKEN_SECRET: tokenSecret,
    MODAL_SERVER_URL: serverUrl, MODAL_ENVIRONMENT: environment ?? '' };
}

export const MODAL_CONNECTED_ACCOUNT_RUNTIME: ConnectedAccountRuntime = {
  authentication: { modes: { token: { kind: 'manual', async complete(input, context) {
    const tokenId = input.fields.tokenId?.trim();
    const tokenSecret = input.fields.tokenSecret?.trim();
    if (!tokenId || !tokenSecret) return { status: 'rejected', diagnostic };
    await context.attemptCredentials.set(tokenIdKey, tokenId);
    await context.attemptCredentials.set(tokenSecretKey, tokenSecret);
    return { status: 'connected', displayName: 'Modal token', scopes: [],
      ...(context.attempt.kind === 'reconnect' ? { accountId: context.attempt.account.accountId } : {}) };
  } } } },
  async status(context) { return await profile(context) ? { status: 'connected', displayName: 'Modal token', scopes: [] } : { status: 'unavailable', diagnostic }; },
  async refresh(context) { return this.status(context); },
  async revoke() { return { status: 'remoteUnsupported' }; },
  async materialize(request, context) {
    if (request.kind !== 'environment' || request.keys.some(key => !MODAL_ENV_KEYS.some(allowed => allowed === key))) {
      throw Object.assign(new Error('Modal materialization is unavailable'), { code: 'credential_unavailable' });
    }
    const selected = await profile(context);
    if (!selected) throw Object.assign(new Error('Modal profile is unavailable'), { code: 'credential_unavailable' });
    const env: Record<string, string> = {};
    for (const key of MODAL_ENV_KEYS) if (request.keys.includes(key)) env[key] = selected[key];
    return { kind: 'environment', env };
  },
};
