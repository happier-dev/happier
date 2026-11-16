import { describe, expect, it } from 'vitest';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { MachineProvisionerOptionsResultV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners';
import * as entry from '../index.js';

describe('Daytona native preparation guest facts', () => {
  it.each([undefined, 'custom-selected-snapshot'])('reports the clean-build target rather than selected-base readiness (%s)', async selected => {
    const requests: string[] = [];
    // Only the host credential store and external HTTP boundary are substituted.
    const services = {
      connectedAccounts: { materialize: async () => ({ kind: 'httpHeaders', headers: { authorization: 'Bearer fixture-key' } }) },
      http: { request: async (request: { url: string }) => { requests.push(request.url); throw new Error('Unexpected network request'); } },
    } as unknown as PluginTestServicesFixture;
    const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services });
    try {
      const snapshot = selected ?? 'daytona-small';
      const result = MachineProvisionerOptionsResultV1Schema.parse(await kit.invokeAction('options', selected ? { snapshot: selected } : {}, { surface: 'plugin' }));
      expect(result.dimensions.image).toMatchObject([{ id: snapshot, nativeFacts: {
        preparationGuest: { target: { os: 'linux', arch: 'x64' }, remoteHomeDir: '/opt/happier' },
        image: { id: snapshot, title: snapshot },
      } }]);
      expect(result.base?.launch).toEqual({ snapshot });
      expect(requests).toEqual([]);
    } finally { await kit.dispose(); }
  });
});
