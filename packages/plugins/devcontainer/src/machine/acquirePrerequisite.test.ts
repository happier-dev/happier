import { describe, expect, it } from 'vitest';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { DEVCONTAINER_PLUGIN } from '../manifest.js';

describe('Devcontainer acquisition prerequisites', () => {
  it.each(['docker', 'devcontainer-cli'] as const)('refuses before allocation when %s is missing', async missing => {
    // Managed-dependency discovery and native execution are host system boundaries.
    const services = {
      managedServices: { dependencies: { status: async (id: string) => id === missing
        ? { state: 'missing', supported: true }
        : { state: 'ready', executable: { kind: 'managedDependency', id: { pluginId: 'happier.devcontainer', localId: id } } } } },
      exec: { run: async () => { throw new Error('Missing prerequisites cannot start native acquisition'); } },
    } as unknown as PluginTestServicesFixture;
    const kit = await createPluginTestkit({ manifest: DEVCONTAINER_PLUGIN.manifest, module: DEVCONTAINER_PLUGIN, services });
    try {
      expect(await kit.invokeAction('acquire', { managedId: 'missing-prerequisite', launch: {
        runtime: 'docker', workspaceFolder: '/workspace', configuration: { kind: 'inline', config: '{"image":"ubuntu:24.04"}' },
      } }, { surface: 'plugin' })).toEqual({ kind: 'rejected', code: 'provider_unavailable' });
    } finally { await kit.dispose(); }
  });
});
