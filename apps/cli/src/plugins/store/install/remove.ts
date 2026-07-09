import { rm } from 'node:fs/promises';

import { createPluginStateStore } from '@/plugins/store/state';
import { resolveInstalledPluginContainerDir } from '@/plugins/store/installPaths';

export type RemoveInstalledPluginResult =
  | Readonly<{
      ok: true;
      pluginId: string;
      removedInstalledPath: string | null;
    }>
  | Readonly<{
      ok: false;
      errorCode: 'plugin_not_found' | 'plugin_not_uninstallable';
      errorMessage: string;
    }>;

export async function removeInstalledPlugin(params: Readonly<{
  happyHomeDir: string;
  pluginId: string;
}>): Promise<RemoveInstalledPluginResult> {
  const store = createPluginStateStore({ happyHomeDir: params.happyHomeDir });
  const state = await store.read();
  const record = state.plugins[params.pluginId];
  if (!record) {
    return {
      ok: false,
      errorCode: 'plugin_not_found',
      errorMessage: `Unknown plugin id: ${params.pluginId}`,
    };
  }

  if (record.source.kind === 'bundled') {
    return {
      ok: false,
      errorCode: 'plugin_not_uninstallable',
      errorMessage: `Bundled first-party plugin '${params.pluginId}' cannot be removed from the local installed plugin catalog`,
    };
  }

  if (record.install.mode === 'managed_install' && record.install.installedPath) {
    await rm(resolveInstalledPluginContainerDir(store.paths.installedDir, params.pluginId), { recursive: true, force: true });
  }

  await store.update(async (current) => {
    if (!current.plugins[params.pluginId]) {
      return current;
    }
    const { [params.pluginId]: _removed, ...rest } = current.plugins;
    return {
      ...current,
      plugins: rest,
    };
  });

  return {
    ok: true,
    pluginId: params.pluginId,
    removedInstalledPath: record.install.installedPath ?? null,
  };
}
