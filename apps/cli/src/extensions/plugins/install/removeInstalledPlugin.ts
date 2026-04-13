import { dirname } from 'node:path';
import { rm } from 'node:fs/promises';

import { createPluginStateStore } from '../store/pluginStateStore';

export type RemoveInstalledPluginResult =
  | Readonly<{
      ok: true;
      pluginId: string;
      removedInstalledPath: string | null;
    }>
  | Readonly<{
      ok: false;
      errorCode: 'plugin_not_found';
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

  if (record.install.mode === 'managed_install' && record.install.installedPath) {
    await rm(dirname(record.install.installedPath), { recursive: true, force: true });
  }

  delete state.plugins[params.pluginId];
  await store.write(state);

  return {
    ok: true,
    pluginId: params.pluginId,
    removedInstalledPath: record.install.installedPath ?? null,
  };
}
