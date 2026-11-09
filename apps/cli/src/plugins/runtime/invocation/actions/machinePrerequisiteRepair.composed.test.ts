import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { DEVCONTAINER_PLUGIN } from '@happier-dev/plugins-devcontainer/manifest';
import { DOCKER_SANDBOXES_PLUGIN } from '@happier-dev/plugins-machine-docker-sandboxes/manifest';
import { CRABBOX_PLUGIN } from '@happier-dev/plugins-machine-crabbox/manifest';

import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { loadCurrentBundledPluginLocatorResult } from '@/plugins/projection/registry/builtIn/locators';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createCommittedContributedActionInvoker } from './createCommittedContributedActionDeps';

// Login persistence and the answering-app hop are external boundaries. The real
// manifest projection, Action executor, surface admission and approval policy run.
vi.mock('@/persistence', async original => ({ ...await original<typeof import('@/persistence')>(),
  readStoredCredentials: async () => null,
}));

describe('bundled Machine prerequisite repair parity', () => {
  it.each(['agent', 'mcp', 'cli'] as const)('admits guidance and retains installer approval on %s', async surface => {
    const manifests = [DEVCONTAINER_PLUGIN.manifest, DOCKER_SANDBOXES_PLUGIN.manifest, CRABBOX_PLUGIN.manifest];
    // The person can require confirmation on CLI as well as automated surfaces.
    // Exercise that existing policy instead of assuming CLI's default asks.
    const actionsSettings = normalizeActionsSettingsV1({ v: 1, actions: Object.fromEntries([
      { pluginId: DEVCONTAINER_PLUGIN.manifest.id, localId: 'install-cli' },
      { pluginId: CRABBOX_PLUGIN.manifest.id, localId: 'install' },
    ].map(action => [formatQualifiedPluginActionId(action), { approvalRequiredSurfaces: [surface] }])) });
    const bundled = loadCurrentBundledPluginLocatorResult();
    const contributes = createResolvedContributionRegistry(projectLoadedPluginContributes({ loadResult: {
      loadedPlugins: bundled.loadedPlugins.filter(plugin => manifests.some(manifest => manifest.id === plugin.pluginId))
        .map(plugin => ({ ...plugin, manifest: normalizePluginManifestV2(manifests.find(manifest => manifest.id === plugin.pluginId)!) })),
      diagnosticsByPluginId: {},
    }, provenance: 'first_party' }));
    const executeClientAction = vi.fn(async () => ({ ok: true as const, result: { url: 'https://installation.example.test/' } }));
    const fixture = await createAdmittedPluginRuntimeFixture({ runtimeOptions: {
      contributes, pluginIds: manifests.map(manifest => manifest.id), executeClientAction,
      resolveCurrentMachineId: () => 'repair-machine',
      resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'repair-server', machineId: 'repair-machine' }),
    } });
    try {
      const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), invokeContributedAction: createCommittedContributedActionInvoker({
        acquireRuntimeRegistryLease: () => fixture.controller.acquireRuntimeRegistry(),
        // The person's consent is an external boundary. Reject through the
        // normal prompt contract instead of opening a real CLI prompt.
        requestCurrentIntent: async () => ({ status: 'rejected', code: 'plugin_action_current_intent_rejected' }),
      }) });
      const results = [];
      for (const [pluginId, localId, input] of [
        [DEVCONTAINER_PLUGIN.manifest.id, 'runtime-install-docs', { runtime: 'docker' }],
        [DOCKER_SANDBOXES_PLUGIN.manifest.id, 'install-docs', {}],
      ] as const) {
        results.push(await executor.execute('action.invoke', { action: { pluginId, localId }, input }, { surface, actionsSettings }));
      }
      for (const [pluginId, localId] of [
        [DEVCONTAINER_PLUGIN.manifest.id, 'install-cli'], [CRABBOX_PLUGIN.manifest.id, 'install'],
      ] as const) {
        // Declining ordinary confirmation must not execute a native install.
        results.push(await executor.execute('action.invoke', { action: { pluginId, localId }, input: {} }, { surface, actionsSettings }));
      }
      expect(results).toMatchObject([
        { ok: true, result: { url: 'https://installation.example.test/' } },
        { ok: true, result: { url: 'https://installation.example.test/' } },
        { ok: false, errorCode: 'plugin_action_current_intent_rejected' },
        { ok: false, errorCode: 'plugin_action_current_intent_rejected' },
      ]);
    } finally { await fixture.dispose(); }
  });
});
