import { describe, expect, it, vi } from 'vitest';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { DOCKER_SANDBOXES_PLUGIN } from './manifest.js';

describe('Docker Sandboxes installation through the controller setup owner', () => {
  it('repairs the missing native prerequisite with its contributed recipe and waits for completion', async () => {
    const sources = [{ kind: 'direct', setup: { items: [{ kind: 'softwareRecipe', selection: {
      ref: { pluginId: DOCKER_SANDBOXES_PLUGIN.manifest.id, recipeId: 'docker-sandboxes-install', revision: '1' }, inputs: {},
    } }] } }];
    const plan = { desiredRevision: 0, sources, exclusions: [], support: [], recipePlans: [] };
    const settled = { kind: 'found', operation: { version: 1, operationId: 'sbx-install', revision: 1,
      actionId: 'machines.setup.apply', state: 'succeeded', scope: { accountId: 'account', machineId: 'controller' },
      title: 'Docker Sandboxes setup', createdAt: 1, startedAt: 1, settledAt: 2, cancellation: 'unsupported' } };
    // Host Action transport and dependency observation are external boundaries;
    // declaration registration and the Plan/Apply adapter execute unchanged.
    const execute = vi.fn(async (action: string): Promise<unknown> => action === 'machines.setup.plan' ? plan
      : action === 'action.operations.get' ? settled : { operationId: 'sbx-install' });
    const services = { actions: { getCurrentExecutionRouting: async () => ({ serverIdentityId: 'home', machineId: 'controller', pluginId: DOCKER_SANDBOXES_PLUGIN.manifest.id }), execute },
      managedServices: { dependencies: { status: async () => ({ state: 'missing', id: 'docker-sandboxes-cli', supported: true }) } },
    } as unknown as PluginTestServicesFixture;
    const kit = await createPluginTestkit({ manifest: DOCKER_SANDBOXES_PLUGIN.manifest, module: DOCKER_SANDBOXES_PLUGIN, services });
    try {
      expect(await kit.invokeAction('check', {}, { surface: 'plugin' })).toMatchObject({ prerequisites: [{
        repairAction: { action: { localId: 'install-runtime' }, input: {} }, setupSources: sources,
      }] });
      await expect(kit.invokeAction('install-runtime', {}, { surface: 'plugin' })).resolves.toEqual({ operationId: 'sbx-install' });
      expect(execute).toHaveBeenCalledWith('machines.setup.apply', { homeId: 'home', machineId: 'controller', targets: [{
        homeId: 'home', machineId: 'controller', desiredRevision: 0, sources, exclusions: [], recipePlans: [],
      }] }, expect.anything());
      expect(execute).toHaveBeenCalledWith('action.operations.get', { serverId: 'home', machineId: 'controller', operationId: 'sbx-install', waitForTerminal: true }, expect.anything());
      execute.mockClear();
      const approval = { kind: 'approval_request_created', artifactId: 'setup-review', actionId: 'machines.setup.plan' };
      execute.mockResolvedValueOnce(approval);
      await expect(kit.invokeAction('install-runtime', {}, { surface: 'plugin' })).resolves.toEqual(approval);
      expect(execute).not.toHaveBeenCalledWith('machines.setup.apply', expect.anything(), expect.anything());
      execute.mockResolvedValueOnce(plan).mockResolvedValueOnce({ operationId: 'sbx-install' }).mockResolvedValueOnce({
        ...settled, operation: { ...settled.operation, state: 'failed', error: { errorCode: 'native_effect_failed', error: 'Installer failed' } },
      });
      await expect(kit.invokeAction('install-runtime', {}, { surface: 'plugin' })).rejects.toMatchObject({ code: 'native_effect_failed' });
    } finally { await kit.dispose(); }
  });
});
