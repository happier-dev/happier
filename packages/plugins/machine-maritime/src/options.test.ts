import { expect, it } from 'vitest';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { MachineProvisionerOptionsResultV1Schema, projectMachineProvisionerSelectionV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import * as entry from './index.js';

it('projects both machine kinds, their real sizes, sleep intents and billing through the public configurator', async () => {
  const services = {
    connectedAccounts: { materialize: async () => ({ kind: 'httpHeaders', headers: { authorization: 'Bearer constructed-secret' } }) },
    http: { request: async ({ url }: { url: string }) => ({ status: 200, finalUrl: url, headers: {},
      body: new TextEncoder().encode(JSON.stringify({ plan: 'growth', minMemMb: 512, maxMemMb: 8192, maxDiskGb: 100 })) }) },
  } as unknown as PluginTestServicesFixture; // Only HTTP and credential persistence cross the host boundary.
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services });
  try {
    const options = MachineProvisionerOptionsResultV1Schema.parse(await kit.invokeAction('options', {}, { surface: 'plugin' }));
    expect(options.dimensions.image.map(o => o.id)).toEqual(['agent-box', 'linux-computer']);
    const box = projectMachineProvisionerSelectionV1({ options, selection: { image: 'agent-box', size: 'box-2048', location: 'account' }, launchSchema: entry.MACHINE_PROVISIONER.launchSchema });
    expect(box).toMatchObject({ kind: 'ready', guestPlatform: 'linux', launch: { kind: 'agent-box', memMb: 2048, alwaysOn: true },
      retention: { supportedIntents: ['start', 'stop', 'suspend', 'resume', 'delete'] }, prices: [{ amount: '1', unit: 'month' }],
      billing: { location: 'cloud', stoppedBilling: 'billed', storageCharges: [{ amount: '0.08', unit: 'GB-month' }] } });
    const computer = projectMachineProvisionerSelectionV1({ options, selection: { image: 'linux-computer', size: 'computer-4096', location: 'account' }, launchSchema: entry.MACHINE_PROVISIONER.launchSchema });
    expect(computer).toMatchObject({ kind: 'ready', guestPlatform: 'linux', launch: { kind: 'linux-computer', memMb: 4096, alwaysOn: false },
      retention: { supportedIntents: ['suspend', 'resume', 'delete'] }, prices: [{ amount: '0.12', unit: 'hour' }],
      billing: { location: 'cloud', stoppedBilling: 'not-billed', storageCharges: [{ amount: '0.08', unit: 'GB-month' }] } });
    expect(projectMachineProvisionerSelectionV1({ options, selection: { image: 'linux-computer', size: 'box-2048', location: 'account' }, launchSchema: entry.MACHINE_PROVISIONER.launchSchema }).kind).toBe('unavailable');
    expect(options.dimensions.location.map(o => [o.id, o.available])).toEqual([['account', true], ['us', false], ['de', false]]);
  } finally { await kit.dispose(); }
});
