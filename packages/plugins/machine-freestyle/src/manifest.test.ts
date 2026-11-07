import { expect, it } from 'vitest';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { MachineProvisionerCheckResultV1Schema, MachineProvisionerOptionsResultV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners';
import * as entry from './index.js';

it.each(['network', 'credential'] as const)('settles Check and Options as typed unavailable on %s failure', async failure => {
  // Substitute only the host credential store and vendor HTTP boundaries.
  const services = {
    connectedAccounts: { materialize: async () => {
      if (failure === 'credential') throw new Error('private-credential-detail');
      return { kind: 'httpHeaders', headers: { authorization: 'Bearer private-token' } };
    } },
    http: { request: async () => { throw new Error('private-vendor-detail'); } },
  } as unknown as PluginTestServicesFixture;
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services });
  try {
    const check = MachineProvisionerCheckResultV1Schema.parse(await kit.invokeAction('check', {}, { surface: 'plugin' }));
    expect(check).toMatchObject({ available: false });
    const options = MachineProvisionerOptionsResultV1Schema.parse(await kit.invokeAction('options', {}, { surface: 'plugin' }));
    expect(options).toEqual({ dimensions: { size: [], location: [], network: [], image: [], duration: [] }, code: 'provider_unavailable' });
    expect(JSON.stringify({ check, options })).not.toContain('private-');
  } finally { await kit.dispose(); }
});
