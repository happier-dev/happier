import { createMachineProvisionerApiKeyAccount } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { PluginAccountApi } from '@happier-dev/plugin-sdk';

export const ACCOUNT_ID = 'railway-account';
export const ACCOUNT_PURPOSE = 'cloud-api';
export const ORIGINS = ['https://backboard.railway.com'] as const;

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

const account = createMachineProvisionerApiKeyAccount({
  name: 'Railway', keyDescription: 'a personal Railway Account API token created with No workspace, not a workspace or project token', codePrefix: 'railway',
  purpose: ACCOUNT_PURPOSE,
  headers: ORIGINS.map(origin => ({ origin, headerName: 'authorization', scheme: 'bearer' as const })),
  probe: {
    request: { url: 'https://backboard.railway.com/graphql/v2', method: 'POST', headers: { 'content-type': 'application/json' },
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
export const connectedAccountRuntime = account.runtime;
export const connectedAccountPortableRuntime = account.portableRuntime;
export function activate(api: PluginAccountApi): void { api.connectedAccounts.register(ACCOUNT_ID, account.portableRuntime); }
export const nativeFetch = account.nativeFetch;
