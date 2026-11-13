import { expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { MachineProvisionerCheckResultV1Schema, MachineProvisionerOptionsResultV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners';
import { railwayVendor } from '../testkit/vendor.js';
import * as entry from './index.js';

it.each(['network', 'credential'] as const)('settles network loss and preserves typed credential refusals on %s failure', async failure => {
  // Captured credentials fail at the host HTTP boundary before vendor dispatch.
  const services = {
    http: { request: async () => {
      if (failure === 'credential') throw new PluginError({ code: 'credential_unavailable' });
      throw new Error('private-vendor-detail');
    } },
  } as unknown as PluginTestServicesFixture;
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services });
  try {
    if (failure === 'credential') {
      await expect(kit.invokeAction('check', {}, { surface: 'plugin' })).rejects.toMatchObject({ code: 'credential_unavailable' });
      await expect(kit.invokeAction('options', {}, { surface: 'plugin' })).rejects.toMatchObject({ code: 'credential_unavailable' });
      return;
    }
    expect(MachineProvisionerCheckResultV1Schema.parse(await kit.invokeAction('check', {}, { surface: 'plugin' })))
      .toMatchObject({ available: false, code: 'railway_unavailable' });
    const options = MachineProvisionerOptionsResultV1Schema.parse(await kit.invokeAction('options', {}, { surface: 'plugin' }));
    expect(options).toEqual({ dimensions: { size: [], location: [], network: [], image: [], duration: [] }, code: 'provider_unavailable' });
    expect(JSON.stringify(options)).not.toContain('private-');
  } finally { await kit.dispose(); }
});

it('requires a selected Railway environment and retains correlation-only recovery without purchasing', async () => {
  const vendor = railwayVendor();
  const services = {
    connectedAccounts: { materialize: async () => ({ kind: 'httpHeaders', headers: { authorization: 'Bearer private-token' } }) },
    http: { request: async (request: { url: string; method: string; headers?: Record<string, string>; body?: Uint8Array }) => {
      const response = await vendor.request(request.url, { method: request.method, headers: request.headers,
        body: request.body === undefined ? undefined : new TextDecoder().decode(request.body) });
      return { status: response.status, finalUrl: request.url, headers: {}, body: new Uint8Array(await response.arrayBuffer()) };
    } },
  } as unknown as PluginTestServicesFixture;
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services });
  try {
    const missing = MachineProvisionerOptionsResultV1Schema.parse(await kit.invokeAction('options', {}, { surface: 'plugin' }));
    expect(missing.base).toBeUndefined();
    const selected = MachineProvisionerOptionsResultV1Schema.parse(await kit.invokeAction('options', { environmentId: 'environment-one' }, { surface: 'plugin' }));
    expect(selected.base).toMatchObject({ launch: { environmentId: 'environment-one' }, guestPlatform: 'linux', retention: { supportedIntents: ['delete'] } });
    const recovered = await kit.invokeAction('reconcile', { correlation: { managedId: 'managed-one', requestId: 'request-one', launch: { environmentId: 'environment-one' } } }, { surface: 'plugin' });
    expect(recovered).toMatchObject({ kind: 'unknown', recovery: { reference: 'managed-one', consoleUrl: 'https://railway.com/dashboard' } });
    expect(vendor.calls.filter(call => call.query.includes('sandboxCreate('))).toHaveLength(0);
  } finally { await kit.dispose(); vendor.cleanup(); }
});
