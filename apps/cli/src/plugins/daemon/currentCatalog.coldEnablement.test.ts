import * as fs from 'node:fs';
import { expect, it, vi } from 'vitest';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createDaemonPluginRegistryRuntimeLifecycle } from '@/plugins/runtime/reload/registryRuntimeLifecycle';
import { readProcessRoleCatalog } from '@/processes/classification/processRoleCatalog';
import { readCurrentDaemonPluginCatalogSnapshot } from './currentCatalog';

it('reads zero disabled built-in files for startup process roles and a cold catalog while retaining its row', async () => {
  await withTempDir('happier-cold-disabled-catalog-', async happyHomeDir => {
    const controller = pluginReloadController;
    const store = createPluginRegistryStateStore({ happyHomeDir,
      runtimeLifecycle: createDaemonPluginRegistryRuntimeLifecycle({ happyHomeDir, reloadController: controller }),
    });
    await store.setEnabledWithResult('happier.agent.pi', false);
    const reloadController = createPluginReloadController({ happyHomeDir });
    const reads = vi.spyOn(fs, 'readFileSync');
    const piReads = () => reads.mock.calls.filter(([path]) =>
      /(?:bundled-plugin-manifests[\\/]pi\.json|plugins[\\/]pi[\\/].*ui-artifacts\.json)$/.test(String(path)));
    try {
      // Startup's process view reads through the same singleton as the daemon.
      readProcessRoleCatalog();
      const disabled = await readCurrentDaemonPluginCatalogSnapshot({ reloadController, happyHomeDir });
      expect(piReads()).toHaveLength(0);
      expect(disabled.plugins.find(plugin => plugin.pluginId === 'happier.agent.pi'))
        .toMatchObject({ machineEnabled: false, enabled: false, source: { kind: 'bundled' } });
      await readCurrentDaemonPluginCatalogSnapshot({ reloadController, happyHomeDir });
      expect(piReads()).toHaveLength(0);
    } finally {
      reads.mockRestore();
      await reloadController.shutdown();
      await controller.shutdown();
    }
  });
});

it('keeps a Machine-disabled built-in cold before a fresh daemon has an active registry', async () => {
  await withTempDir('happier-fresh-disabled-catalog-', async happyHomeDir => {
    const store = createPluginRegistryStateStore({ happyHomeDir,
      runtimeLifecycle: createDaemonPluginRegistryRuntimeLifecycle({ happyHomeDir, reloadController: pluginReloadController }),
    });
    await store.setEnabledWithResult('happier.agent.pi', false);
    await pluginReloadController.shutdown();
    vi.resetModules();
    vi.stubEnv('HAPPIER_HOME_DIR', happyHomeDir);
    const { configuration } = await import('@/configuration');
    expect(configuration.happyHomeDir).toBe(happyHomeDir);
    const reads = vi.spyOn(fs, 'readFileSync');
    try {
      const { readProcessRoleCatalog: readFreshProcessRoles } = await import('@/processes/classification/processRoleCatalog');
      const roles = readFreshProcessRoles();
      readFreshProcessRoles();
      expect(reads.mock.calls.filter(([path]) =>
        /(?:bundled-plugin-manifests[\\/]pi\.json|plugins[\\/]pi[\\/].*ui-artifacts\.json)$/.test(String(path))))
        .toHaveLength(0);
      expect(roles.agentExecutables.some(agent => agent.executable === 'pi')).toBe(false);
      expect(roles.agentExecutables.length).toBeGreaterThan(0);
      expect(reads.mock.calls.filter(([path]) => String(path).endsWith('registry-current.v1.json'))).toHaveLength(1);
    } finally {
      reads.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
