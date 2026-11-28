import { expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { MachineProvisionerCheckResultV1Schema, MachineProvisionerOptionsResultV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners';
import { railwayVendor } from '../testkit/vendor.js';
import { unselectedConnectedAccount } from '../../../../apps/cli/src/plugins/testkit/unselectedConnectedAccount';
import { ACCOUNT_ID, ACCOUNT_PURPOSE } from './account.js';
import * as entry from './index.js';

it('requests workspace and project at the same access level for Railway OAuth consent', () => {
  const authentication = entry.manifest.contributes.connectedAccountDescriptors
    ?.find(descriptor => descriptor.id === ACCOUNT_ID)?.authentication;
  if (!authentication) throw new Error('Expected the Railway account authentication declaration');
  const mode = authentication.modes.find(mode => mode.id === authentication.defaultModeId);
  if (mode?.kind !== 'oauthAuthorizationCode' || !mode.scopes) throw new Error('Expected the default Railway OAuth scopes');

  const workspaceLevels = mode.scopes.filter(scope => scope.startsWith('workspace:')).map(scope => scope.split(':')[1]);
  const projectLevels = mode.scopes.filter(scope => scope.startsWith('project:')).map(scope => scope.split(':')[1]);
  expect(workspaceLevels).toEqual(['admin']);
  expect(projectLevels).toEqual(workspaceLevels);
});

it('carries the purpose owner refusal through Railway options', async () => {
  const connectedAccounts = unselectedConnectedAccount({
    service: { pluginId: entry.manifest.id, localId: ACCOUNT_ID },
    purpose: ACCOUNT_PURPOSE, version: entry.manifest.version, action: 'options',
  });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services: { connectedAccounts } });
  try {
    await expect(kit.invokeAction('options', {}, { surface: 'plugin' }))
      .rejects.toMatchObject({ code: 'plugin_host_access_resource_not_selected' });
  } finally { await kit.dispose(); }
});

it.each(['network', 'credential'] as const)('classifies %s failures during the Railway access check', async failure => {
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
      return;
    }
    const result = MachineProvisionerCheckResultV1Schema.parse(await kit.invokeAction('check', {}, { surface: 'plugin' }));
    expect(result).toMatchObject({ available: false, code: 'railway_unavailable' });
    expect(JSON.stringify(result)).not.toContain('private-');
  } finally { await kit.dispose(); }
});

it('requires a selected Railway environment and retains correlation-only recovery without purchasing', async () => {
  const vendor = railwayVendor();
  const services = {
    connectedAccounts: { materialize: async (_purpose: string, request: { kind: string }) => request.kind === 'environment'
      ? { kind: 'environment', env: {} }
      : { kind: 'httpHeaders', headers: { authorization: 'Bearer private-token' } } },
    http: { request: async (request: { url: string; method: string; headers?: Record<string, string>; body?: Uint8Array }) => {
      const response = await vendor.request(request.url, { method: request.method, headers: request.headers,
        body: request.body === undefined ? undefined : new TextDecoder().decode(request.body) });
      return { status: response.status, finalUrl: request.url, headers: {}, body: new Uint8Array(await response.arrayBuffer()) };
    } },
  } as unknown as PluginTestServicesFixture;
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services });
  try {
    const missing = MachineProvisionerOptionsResultV1Schema.parse(await kit.invokeAction('options', {}, { surface: 'plugin' }));
    expect(missing).toEqual({ dimensions: { size: [], location: [], network: [], image: [], duration: [] } });
    const selected = MachineProvisionerOptionsResultV1Schema.parse(await kit.invokeAction('options', { environmentId: 'environment-one' }, { surface: 'plugin' }));
    expect(selected.base).toMatchObject({ launch: { environmentId: 'environment-one' }, guestPlatform: 'linux', retention: { supportedIntents: ['delete'] } });
    const recovered = await kit.invokeAction('reconcile', { correlation: { managedId: 'managed-one', requestId: 'request-one', launch: { environmentId: 'environment-one' } } }, { surface: 'plugin' });
    expect(recovered).toMatchObject({ kind: 'unknown', recovery: { reference: 'managed-one', consoleUrl: 'https://railway.com/dashboard' } });
    expect(vendor.calls.filter(call => call.query.includes('sandboxCreate('))).toHaveLength(0);
  } finally { await kit.dispose(); vendor.cleanup(); }
});
