import { createMachineProvisionerApiKeyAccount } from '@happier-dev/plugin-sdk/machine-provisioners';
import { FlyAppsResponseSchema, formatFlyAuthorization } from './machine/nativeClient.js';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';

export const ACCOUNT_ID = 'fly-account';
export const ACCOUNT_PURPOSE = 'cloud-api';

const account = createMachineProvisionerApiKeyAccount({
  name: 'Fly', keyDescription: 'a Fly organization token with access to the selected organization, not an app-only deploy token', codePrefix: 'fly',
  purpose: ACCOUNT_PURPOSE,
  methods: ['GET', 'POST', 'DELETE'],
  headers: [
    { origin: 'https://api.machines.dev', headerName: 'Authorization', scheme: formatFlyAuthorization },
    { origin: 'https://api.fly.io', headerName: 'Authorization', scheme: formatFlyAuthorization },
  ],
  probe: {
    request(context) {
      const organizationSlug = context.configuration.values.organizationSlug;
      if (typeof organizationSlug !== 'string' || !organizationSlug.trim()) return { status: 'rejected', diagnostic: {
        code: 'fly_invalid_configuration', severity: 'error', message: 'Choose the Fly organization to connect.' } };
      return { url: 'https://api.machines.dev/v1/apps?' + new URLSearchParams({ org_slug: organizationSlug }), method: 'GET' };
    },
    read(value) {
      const parsed = FlyAppsResponseSchema.safeParse(value);
      if (!parsed.success) return undefined;
      return { status: 'connected', displayName: 'Fly', scopes: [] };
    },
  },
});
export const connectedAccountRuntime: ConnectedAccountRuntime = {
  ...account.runtime,
  async materialize(request, context, options) {
    if (request.kind === 'environment' && request.keys.every(key => key === 'FLY_ORGANIZATION')) {
      const signal = options?.signal ? AbortSignal.any([context.signal, options.signal]) : context.signal;
      signal.throwIfAborted();
      const organizationSlug = context.configuration.values.organizationSlug;
      if (typeof organizationSlug !== 'string' || !organizationSlug.trim()) throw new PluginError({ code: 'credential_unavailable' });
      return { kind: 'environment', env: { FLY_ORGANIZATION: organizationSlug } };
    }
    return account.runtime.materialize(request, context, options);
  },
};
export const nativeFetch = account.nativeFetch;
