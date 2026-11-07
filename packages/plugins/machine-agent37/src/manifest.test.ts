import { expect, it } from 'vitest';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { MachineProvisionerOptionsResultV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners';
import * as entry from './index.js';

it('runs the public Account actions through real schemas and native HTTP wiring', async () => {
  const requests: { url: string; method: string }[] = [];
  const services = {
    connectedAccounts: { materialize: async (_purpose: string, request: { origin: string }) => ({ kind: 'httpHeaders',
      headers: request.origin === 'https://api.agent37.com' ? { authorization: 'Bearer constructed-private-key' } : { 'x-agent37-key': 'constructed-private-key' } }) },
    http: { request: async (request: { url: string; method: string }) => {
      requests.push({ url: request.url, method: request.method });
      return { status: request.method === 'POST' ? 201 : 200, finalUrl: request.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(
        request.method === 'POST' ? { id: 'ab12cd34ef', status: 'running' } : { data: [] })) };
    } },
  } as unknown as PluginTestServicesFixture;
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry.PLUGIN, services });
  try {
    const options = MachineProvisionerOptionsResultV1Schema.parse(await kit.invokeAction('options', {}, { surface: 'plugin' }));
    expect(options.dimensions.image.map(o => o.id)).toEqual(['vm', 'default', 'performance']);
    const result = await kit.invokeAction('acquire', { managedId: 'managed-one', launch: { kind: 'vm', size: '2-4', region: 'eu' } }, { surface: 'plugin' });
    expect(result).toMatchObject({ kind: 'bound', resource: { contributionRef: { pluginId: 'happier.machine.agent37', localId: 'agent37' }, value: { instanceId: 'ab12cd34ef', kind: 'vm', region: 'eu' } } });
    expect(requests.some(r => r.method === 'POST' && r.url === 'https://api.agent37.com/v1/instances')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('constructed-private-key');
    await expect(kit.invokeAction('acquire', { managedId: 'invalid', launch: { kind: 'default', size: '2-4', region: 'eu' } }, { surface: 'plugin' })).rejects.toThrow();
  } finally { await kit.dispose(); }
});

it('keeps the API key on the canonical secret field so Saved Secret references stay host-owned', () => {
  const mode = entry.manifest.contributes.connectedAccountDescriptors?.[0]?.authentication?.modes[0];
  expect(mode).toMatchObject({ kind: 'manual', credentialFieldKeys: { token: 'token' }, fields: [{ id: 'token', secret: true }] });
});
