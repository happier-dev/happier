import { afterEach, describe, expect, it } from 'vitest';

import type { Credentials } from '@/persistence';
import { BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES } from '../../../plugins/projection/registry/sources/generatedBundledPluginManifests';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { resolveBackendEngineAdapterResolution } from './engineRegistry';

const ANTIGRAVITY_BACKEND_ID = 'antigravity';
const ANTIGRAVITY_PLUGIN_ID = 'happier.agent.antigravity';

function createTestCredentials(): Credentials {
  return {
    token: 'test-token',
    encryption: {
      type: 'legacy',
      secret: new Uint8Array(32).fill(1),
    },
  };
}

describe('engineRegistry (antigravity runtimeCore)', () => {
  let fixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | null = null;
  afterEach(async () => {
    await fixture?.dispose();
    fixture = null;
  });
  it('resolves bundled Antigravity runtime ownership through the plugin backend engine', async () => {
    fixture = await createAdmittedPluginRuntimeFixture({
      runtimeOptions: { pluginIds: [ANTIGRAVITY_PLUGIN_ID] },
    });
    const runtimeRegistry = fixture.registry;
    const activationTarget = runtimeRegistry.contributes.activationTargets.find((target) => target.pluginId === ANTIGRAVITY_PLUGIN_ID);
    expect({
      activationDaemonEntryPath: activationTarget?.daemonEntryPath,
      bundledPackageNamesIncludeAntigravity: BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES.includes('@happier-dev/plugins-antigravity'),
    }).toEqual({
      activationDaemonEntryPath: '@happier-dev/plugins-antigravity',
      bundledPackageNamesIncludeAntigravity: true,
    });

    expect({
      engines: [...runtimeRegistry.agentRuntimesByAgentId.entries()].map(([backendId, entry]) => ({
        backendId,
        pluginId: entry.pluginId,
      })),
      diagnostics: runtimeRegistry.pluginDiagnosticsByPluginId,
    }).toEqual({
      engines: [{
        backendId: ANTIGRAVITY_BACKEND_ID,
        pluginId: ANTIGRAVITY_PLUGIN_ID,
      }],
      diagnostics: {
        [ANTIGRAVITY_PLUGIN_ID]: [],
      },
    });

    const resolution = await resolveBackendEngineAdapterResolution(ANTIGRAVITY_BACKEND_ID, {
      runtimeRegistry,
    });

    expect({
      selectedSource: resolution?.selectedSource,
      runtimeOwner: resolution?.runtimeOwner,
      diagnostics: resolution?.diagnostics,
      backendPluginId: resolution?.backend.pluginId,
      backendDaemonEntryPath: resolution?.backend.daemonEntryPath,
    }).toEqual({
      selectedSource: 'plugin',
      runtimeOwner: {
        backendId: ANTIGRAVITY_BACKEND_ID,
        selected: {
          kind: 'plugin_engine',
          ownerId: ANTIGRAVITY_PLUGIN_ID,
          provenance: 'first_party',
          pluginId: ANTIGRAVITY_PLUGIN_ID,
        },
        candidates: [{
          kind: 'plugin_engine',
          ownerId: ANTIGRAVITY_PLUGIN_ID,
          provenance: 'first_party',
          pluginId: ANTIGRAVITY_PLUGIN_ID,
        }],
      },
      diagnostics: [],
      backendPluginId: ANTIGRAVITY_PLUGIN_ID,
      backendDaemonEntryPath: '@happier-dev/plugins-antigravity',
    });

    const plan = await resolution!.engineAdapter.runtimeCore.createSessionRuntime({
      credentials: createTestCredentials(),
      directory: '/tmp/antigravity',
      permissionMode: 'default',
      metadata: {
        runtimeDescriptorV1: {
          v: 1,
          agentId: ANTIGRAVITY_BACKEND_ID,
          provider: { runtimeMode: 'cliPrint' },
        },
      },
    });

    expect(plan).toMatchObject({
      kind: 'hostSessionRuntimePlan',
      agentId: ANTIGRAVITY_BACKEND_ID,
      config: {
        providerName: 'Antigravity CLI',
        agentMessageType: ANTIGRAVITY_BACKEND_ID,
      },
    });
    expect(plan.config.createSessionRuntime).toEqual(expect.any(Function));
  });
});
