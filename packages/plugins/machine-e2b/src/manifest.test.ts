import { expect, it } from 'vitest';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { MachineProvisionerCheckResultV1Schema, MachineProvisionerOptionsResultV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners';
import * as entry from './index.js';

it.each(['network', 'credential'] as const)('Check and Options return schema-valid unavailable results on %s failure', async failure => {
  // The host credential store and vendor network are the only substituted boundaries.
  const services = {
    connectedAccounts: { materialize: async () => {
      if (failure === 'credential') throw new Error('private-credential-message');
      return { kind: 'httpHeaders', headers: { 'x-api-key': 'private-key' } };
    } },
    http: { request: async () => { throw new Error('private-vendor-message'); } },
  } as unknown as PluginTestServicesFixture;
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services });
  try {
    const check = MachineProvisionerCheckResultV1Schema.parse(await kit.invokeAction('check', {}, { surface: 'plugin' }));
    const options = MachineProvisionerOptionsResultV1Schema.parse(await kit.invokeAction('options', {}, { surface: 'plugin' }));
    expect(check).toMatchObject({ available: false, code: failure === 'credential' ? 'credential_unavailable' : 'provider_unavailable' });
    expect(options).toEqual({ dimensions: { size: [], location: [], network: [], image: [], duration: [] }, code: 'provider_unavailable' });
  } finally { await kit.dispose(); }
});
