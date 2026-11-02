import { describe, expect, it } from 'vitest';

import { configuration } from '@/configuration';
import { getResolvedContributionRegistry } from '@/plugins/projection/registry/builtIn/snapshot';
import { resolveBundledPluginEnablement } from '@/plugins/projection/registry/builtIn/enablement';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';

import { resolveSpawnBackendIdentity } from './resolveSpawnBackendIdentity';

describe('Session Agent identity admission', () => {
  it.each(['account', 'machine'] as const)('preserves the effective %s-disabled refusal for fresh and resumed Sessions, then restores routing', async (scope) => {
    const pluginId = 'happier.agent.pi';
    const request = { resume: '', agentTarget: { kind: 'agent' as const, identity: { pluginId, localId: 'pi' } },
      backendTarget: undefined, credentials: null };
    const disabled = await createAdmittedPluginRuntimeFixture({
      happyHomeDir: configuration.happyHomeDir, controller: pluginReloadController,
      runtimeOptions: { pluginIds: [], contributes: getResolvedContributionRegistry({
        pluginEnablementById: resolveBundledPluginEnablement({ pluginIds: [pluginId],
          accountEnabledById: new Map([[pluginId, scope !== 'account']]),
          machineEnabledById: { [pluginId]: scope !== 'machine' } }),
      }) },
    });
    try {
      for (const existingSessionId of ['', 'retained-pi-session']) {
        await expect(resolveSpawnBackendIdentity({ ...request, existingSessionId })).resolves.toMatchObject({
          ok: false, error: { type: 'error', errorCode: 'SPAWN_FAILED',
            errorDetail: { kind: 'launch_error', code: 'plugin_disabled' } },
        });
      }
    } finally { await disabled.dispose(); }
    const enabled = await createAdmittedPluginRuntimeFixture({
      happyHomeDir: configuration.happyHomeDir, controller: pluginReloadController,
      runtimeOptions: { pluginIds: [], contributes: getResolvedContributionRegistry({
        pluginEnablementById: resolveBundledPluginEnablement({ pluginIds: [pluginId] }),
      }) },
    });
    try {
      await expect(resolveSpawnBackendIdentity({ ...request, existingSessionId: '' })).resolves.toMatchObject({
        ok: true, catalogAgentId: 'pi', effectiveBackendTargetV2: { backendId: 'pi' },
      });
    } finally { await enabled.dispose(); }
  });
});
