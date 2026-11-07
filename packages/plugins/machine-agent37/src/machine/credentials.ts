import { createMachineProvisionerMaterializedFetch } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { ACCOUNT_PURPOSE } from '../account.js';

const origin = 'https://api.agent37.com';
type Invocation = Readonly<{
  signal: AbortSignal;
  services: Readonly<{
    connectedAccounts: Pick<PluginAccountActionContext['services']['connectedAccounts'], 'materialize'>;
    http: Pick<PluginAccountActionContext['services']['http'], 'request'>;
  }>;
}>;


/** The control and exec APIs use distinct documented headers from the same selected account. */
export function nativeFetch(context: Invocation): typeof fetch {
  const control = createMachineProvisionerMaterializedFetch(context, {
    purpose: ACCOUNT_PURPOSE, origin, headerName: 'authorization', methods: ['GET', 'POST', 'DELETE'],
  });
  const data = createMachineProvisionerMaterializedFetch(context, {
    purpose: ACCOUNT_PURPOSE, origin: 'https://sandbox.agent37.app', headerName: 'x-agent37-key', methods: ['POST'],
  });
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return (url.origin === 'https://sandbox.agent37.app' ? data : control)(input, init);
  };
}
