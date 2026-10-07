import { afterEach, describe, expect, it } from 'vitest';

import type { Credentials } from '@/persistence';
import { BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES } from '../../../plugins/projection/registry/sources/generatedBundledPluginManifests';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { isExecutionRunHostRuntime } from '../bridges/executionRun/executionRunHostRuntime';
import { resolveBackendEngineAdapterResolution } from './engineRegistry';

const GEMINI_BACKEND_ID = 'gemini';
const GEMINI_PLUGIN_ID = 'happier.agent.gemini';

function createTestCredentials(): Credentials {
  return {
    token: 'test-token',
    encryption: {
      type: 'legacy',
      secret: new Uint8Array(32).fill(1),
    },
  };
}

describe('engineRegistry (gemini runtimeCore)', () => {
  let fixture: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | null = null;
  afterEach(async () => {
    await fixture?.dispose();
    fixture = null;
  });
  it('resolves the bundled Gemini ACP plugin runtimeCore through production dispatch', async () => {
    fixture = await createAdmittedPluginRuntimeFixture({
      runtimeOptions: { pluginIds: [GEMINI_PLUGIN_ID] },
    });
    const runtimeRegistry = fixture.registry;
    const activationTarget = runtimeRegistry.contributes.activationTargets.find((target) => target.pluginId === GEMINI_PLUGIN_ID);
    expect({
      activationDaemonEntryPath: activationTarget?.daemonEntryPath,
      bundledPackageNamesIncludeGemini: BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES.includes('@happier-dev/plugins-gemini'),
    }).toEqual({
      activationDaemonEntryPath: '@happier-dev/plugins-gemini',
      bundledPackageNamesIncludeGemini: true,
    });

    expect({
      engines: [...runtimeRegistry.agentRuntimesByAgentId.entries()].map(([backendId, entry]) => ({
        backendId,
        pluginId: entry.pluginId,
      })),
      diagnostics: runtimeRegistry.pluginDiagnosticsByPluginId,
    }).toEqual({
      engines: [{
        backendId: GEMINI_BACKEND_ID,
        pluginId: GEMINI_PLUGIN_ID,
      }],
      diagnostics: {
        [GEMINI_PLUGIN_ID]: [],
      },
    });

    const resolution = await resolveBackendEngineAdapterResolution(GEMINI_BACKEND_ID, {
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
        backendId: GEMINI_BACKEND_ID,
        selected: {
          kind: 'plugin_engine',
          ownerId: GEMINI_PLUGIN_ID,
          provenance: 'first_party',
          pluginId: GEMINI_PLUGIN_ID,
        },
        candidates: [{
          kind: 'plugin_engine',
          ownerId: GEMINI_PLUGIN_ID,
          provenance: 'first_party',
          pluginId: GEMINI_PLUGIN_ID,
        }],
      },
      diagnostics: [],
      backendPluginId: GEMINI_PLUGIN_ID,
      backendDaemonEntryPath: '@happier-dev/plugins-gemini',
    });

    const plan = await resolution!.engineAdapter.runtimeCore.createSessionRuntime({
      credentials: createTestCredentials(),
      directory: '/tmp/gemini',
      permissionMode: 'safe-yolo',
    });

    expect(plan).toMatchObject({
      kind: 'hostSessionRuntimePlan',
      agentId: GEMINI_BACKEND_ID,
      config: {
        providerName: 'Gemini CLI',
        agentMessageType: 'gemini',
      },
    });
    expect(plan.config.createSessionRuntime).toEqual(expect.any(Function));

    const executionRunRuntime = resolution!.engineAdapter.runtimeCore.createExecutionRunBackend({
      scope: 'detached',
      backendId: GEMINI_BACKEND_ID,
      cwd: '/tmp/gemini',
      permissionMode: 'read_only',
      accountSettings: null,
    });

    expect(isExecutionRunHostRuntime(executionRunRuntime)).toBe(true);
  });
});
