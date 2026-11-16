import { expect, it } from 'vitest';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { MachineProvisionerCheckResultV1Schema, MachineProvisionerOptionsResultV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners';
import * as entry from './index.js';
import { readMachineProvisionerHostAvailability } from '@happier-dev/cli-common/machines/managed/provisioners';

it('admits the complete HTTP bootstrap recipe on a browser host', () => {
  expect(readMachineProvisionerHostAvailability({ host: 'browser', provisioner: entry.MACHINE_PROVISIONER }))
    .toEqual({ available: true, executionTarget: 'account', requiresController: false });
});

it.each(['network', 'credential'] as const)('keeps Check unavailable and static Options usable on %s failure', async failure => {
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
    expect(options.base?.launch).toEqual({ snapshot: 'daytona-small' });
    expect(JSON.stringify({ check, options })).not.toContain('private-');
  } finally { await kit.dispose(); }
});

it('uses one current-key GET per configuration question with snapshot selectors', async () => {
  const requests: { path: string; method: string }[] = [];
  // Only the host credential store and vendor HTTP transport are substituted.
  const services = {
    connectedAccounts: { materialize: async () => ({ kind: 'httpHeaders', headers: { authorization: 'Bearer test-token' } }) },
    http: { request: async (request: { url: string; method: string }) => {
      requests.push({ path: new URL(request.url).pathname, method: request.method });
      return { finalUrl: request.url, status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({
        permissions: ['write:sandboxes', 'delete:sandboxes'],
      })) };
    } },
  } as unknown as PluginTestServicesFixture;
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services });
  try {
    // readManagedConfiguration asks Check plus Options when selectors are present.
    for (const snapshot of ['daytona-small', 'selected-snapshot']) {
      requests.length = 0;
      const [check, choices] = await Promise.all([
        kit.invokeAction('check', {}, { surface: 'plugin' }),
        kit.invokeAction('options', { snapshot }, { surface: 'plugin' }),
      ]);
      expect(MachineProvisionerCheckResultV1Schema.parse(check)).toMatchObject({ available: true });
      expect(MachineProvisionerOptionsResultV1Schema.parse(choices).base?.launch).toEqual({ snapshot });
      expect(requests).toEqual([{ path: '/api/api-keys/current', method: 'GET' }]);
    }
  } finally { await kit.dispose(); }
});
