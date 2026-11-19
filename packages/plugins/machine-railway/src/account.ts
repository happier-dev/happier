import { createMachineProvisionerApiKeyAccount } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { PluginAccountApi } from '@happier-dev/plugin-sdk';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { ConnectedAccountPortableRuntime, ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { ACCOUNT_PURPOSE, ORIGINS, RAILWAY_API } from './railwayApi.js';
import { railwayOAuthMode, railwayOAuthStatus, refreshRailwayOAuth, revokeRailwayOAuth } from './oauth.js';

export { ACCOUNT_PURPOSE, ORIGINS, nativeFetch } from './railwayApi.js';
export const RAILWAY_ENVIRONMENT_KEY = 'RAILWAY_ENVIRONMENT_ID';

export const ACCOUNT_ID = 'railway-account';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

const account = createMachineProvisionerApiKeyAccount({
  name: 'Railway', keyDescription: 'a personal Railway Account API token created with No workspace, not a workspace or project token', codePrefix: 'railway',
  purpose: ACCOUNT_PURPOSE,
  headers: ORIGINS.map(origin => ({ origin, headerName: 'authorization', scheme: 'bearer' as const })),
  probe: {
    request: { url: RAILWAY_API, method: 'POST', headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ query: 'query { me { id name email } }' })) },
    read(value) {
      if (!object(value)) return undefined;
      if ('errors' in value && (!Array.isArray(value.errors) || value.errors.length > 0)) {
        const denied = Array.isArray(value.errors) && value.errors.some(error => object(error)
          && (object(error.extensions) && ['UNAUTHENTICATED', 'FORBIDDEN'].includes(String(error.extensions.code))
            || typeof error.message === 'string' && /^(?:not authorized|unauthorized|invalid token)[.!]?$/iu.test(error.message.trim())));
        return denied ? { status: 'rejected', diagnostic: { code: 'railway_invalid_token', severity: 'error',
          message: 'Railway refused this token. Use a personal Railway Account API token created with No workspace, not a workspace or project token.' } } : undefined;
      }
      const me = object(value.data) ? value.data.me : undefined;
      if (!object(me) || typeof me.id !== 'string' || !me.id.trim()
        || me.name !== null && typeof me.name !== 'string'
        || me.email !== null && (typeof me.email !== 'string' || !me.email.trim())) return undefined;
      return { status: 'connected', displayName: me.name?.trim() || me.email || me.id,
        providerIdentity: { accountId: me.id, email: me.email, organizationId: null }, scopes: [] };
    },
  },
});
export const connectedAccountRuntime: ConnectedAccountRuntime = {
  authentication: { modes: { ...account.runtime.authentication.modes, oauth: railwayOAuthMode } },
  status: (context, options) => context.configuration.target.modeId === 'oauth'
    ? railwayOAuthStatus(context, options) : account.runtime.status(context, options),
  refresh: (context, options) => context.configuration.target.modeId === 'oauth'
    ? refreshRailwayOAuth(context, options) : account.runtime.refresh(context, options),
  revoke: (context, options) => context.configuration.target.modeId === 'oauth'
    ? revokeRailwayOAuth(context, options) : account.runtime.revoke(context, options),
  async materialize(request, context, options) {
    if (request.kind !== 'environment') return account.runtime.materialize(request, context, options);
    context.signal.throwIfAborted();
    options?.signal?.throwIfAborted();
    const { environmentId } = context.configuration.values;
    if (context.configuration.target.modeId !== 'oauth' || typeof environmentId !== 'string' || !environmentId
      || request.keys.some(key => key !== RAILWAY_ENVIRONMENT_KEY)) throw new PluginError({ code: 'credential_unavailable' });
    return { kind: 'environment', env: Object.fromEntries(request.keys.map(key => [key, environmentId])) };
  },
};
export const connectedAccountPortableRuntime: ConnectedAccountPortableRuntime = {
  authentication: connectedAccountRuntime.authentication, materialize: connectedAccountRuntime.materialize,
};
export function activate(api: PluginAccountApi): void { api.connectedAccounts.register(ACCOUNT_ID, connectedAccountPortableRuntime); }
