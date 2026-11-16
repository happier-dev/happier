import { expect, it } from 'vitest';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { MachineProvisionerCheckResultV1Schema, MachineProvisionerOptionsResultV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners';
import * as entry from './index.js';
import { readMachineProvisionerPreparedLaunchV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';

it('offers prepared Linux/x64 guests and maps an owned prepared artifact through the canonical launch owner', async () => {
  const services = { http: { request: async (request: { url: string }) => ({ status: 200, finalUrl: request.url,
    headers: {}, body: new TextEncoder().encode(JSON.stringify({ vms: [], totalCount: 0 })) }) } } as unknown as PluginTestServicesFixture;
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services });
  try {
    const options = MachineProvisionerOptionsResultV1Schema.parse(await kit.invokeAction('options', {}, { surface: 'plugin' }));
    expect(options.dimensions.image[0]?.nativeFacts?.preparationGuest).toEqual({ target: { os: 'linux', arch: 'x64' }, remoteHomeDir: '/opt/happier' });
    const descriptor = entry.manifest.contributes?.machineProvisioners?.find(value => value.id === 'freestyle');
    expect(descriptor?.preparation?.actions).toEqual({ build: 'prepare-build', inspect: 'prepare-inspect', destroy: 'prepare-destroy' });
    if (!descriptor) throw new Error('Missing Freestyle declaration');
    expect(readMachineProvisionerPreparedLaunchV1({ descriptor,
      provisioner: { pluginId: 'happier.machine.freestyle', localId: 'freestyle' }, artifact: {
        contributionRef: { pluginId: 'happier.machine.freestyle', localId: 'freestyle' }, schemaVersion: 1,
        value: { name: 'happier-prepared-test', managedId: 'prepared-test', vmId: 'vm-builder', snapshotId: 'sh-prepared', launch: { snapshotId: 'sh-prepared' } },
      } })).toMatchObject({ success: true, data: { snapshotId: 'sh-prepared' } });
  } finally { await kit.dispose(); }
});

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
