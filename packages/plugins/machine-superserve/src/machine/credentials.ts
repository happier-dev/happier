import { createMachineProvisionerMaterializedFetch } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { ACCOUNT_PURPOSE, API_ORIGIN, GUEST_ORIGIN } from '../account.js';

const origin = API_ORIGIN;
type Invocation = Readonly<{
  signal: AbortSignal;
  services: Readonly<{
    connectedAccounts: Pick<PluginAccountActionContext['services']['connectedAccounts'], 'materialize'>;
    http: Pick<PluginAccountActionContext['services']['http'], 'request'>;
  }>;
}>;


/** One admitted role captures its credential; its HTTP fragments share that use. */
export function nativeFetch(context: Invocation): typeof fetch {
  return createMachineProvisionerMaterializedFetch(context, {
    purpose: ACCOUNT_PURPOSE, origin, headerName: 'x-api-key', methods: ['GET', 'POST', 'DELETE'],
    isGuestUrl: url => url.origin === GUEST_ORIGIN,
  });
}
