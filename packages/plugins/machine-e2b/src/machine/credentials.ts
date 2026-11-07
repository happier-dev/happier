import { createMachineProvisionerMaterializedFetch } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { ACCOUNT_PURPOSE } from '../account.js';

const origin = 'https://api.e2b.app';
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
    isGuestUrl: url => url.protocol === 'https:' && url.hostname.endsWith('.e2b.app') && url.port === '',
  });
}
