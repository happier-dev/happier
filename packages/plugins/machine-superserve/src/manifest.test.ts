import { expect, it } from 'vitest';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { MachineProvisionerCheckResultV1Schema, MachineProvisionerOptionsResultV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners';
import * as entry from './index.js';

it.each(['network', 'credential'] as const)('Check reports %s failure and Options still supplies static inputs', async failure => {
  // The host credential store and vendor network are the only substituted boundaries.
  let credentialReads = 0;
  const requests: URL[] = [];
  const services = {
    connectedAccounts: { materialize: async () => {
      credentialReads++;
      if (failure === 'credential') throw new Error('private-credential-message');
      return { kind: 'httpHeaders', headers: { 'x-api-key': 'private-key' } };
    } },
    http: { request: async ({ url }: { url: string }) => {
      requests.push(new URL(url));
      throw new Error('private-vendor-message');
    } },
  } as unknown as PluginTestServicesFixture;
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services });
  try {
    const check = MachineProvisionerCheckResultV1Schema.parse(await kit.invokeAction('check', {}, { surface: 'plugin' }));
    expect(check).toMatchObject({ available: false, code: failure === 'credential' ? 'credential_unavailable' : 'provider_unavailable' });
    expect(requests.map(url => url.searchParams.get('limit'))).toEqual(failure === 'network' ? ['1'] : []);
    const observed = { credentialReads, requests: requests.length };
    const options = MachineProvisionerOptionsResultV1Schema.parse(await kit.invokeAction('options', {}, { surface: 'plugin' }));
    expect(options.base).toMatchObject({ launch: { template: 'superserve/base' } });
    expect({ credentialReads, requests: requests.length }).toEqual(observed);
  } finally { await kit.dispose(); }
});
