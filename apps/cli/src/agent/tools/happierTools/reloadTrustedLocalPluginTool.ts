import { createPluginStateStore } from '@/plugins/store/state';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';

import type { HappierBuiltInToolDispatchResult } from './types';

type ReloadPluginResult =
  | Readonly<{
      ok: true;
      generation: number;
      attemptedGeneration: number;
      changedPluginIds: readonly string[];
      affectedPluginIds: readonly string[];
      activeGenerationId: string;
      registryStatus: 'active' | 'last_known_good';
      diagnostics: readonly Readonly<{ code: 'plugin_reload_failed'; message: string }>[];
    }>
  | Readonly<{
      ok: false;
      generation: number;
      attemptedGeneration: number;
      changedPluginIds: readonly string[];
      affectedPluginIds: readonly string[];
      activeGenerationId: string | null;
      registryStatus: 'unavailable';
      diagnostics: readonly Readonly<{ code: 'plugin_reload_failed'; message: string }>[];
    }>;

function err(errorCode: string, error: string): HappierBuiltInToolDispatchResult {
  return { ok: false, errorCode, error };
}

function isTrustedLocalDevPlugin(state: Awaited<ReturnType<ReturnType<typeof createPluginStateStore>['read']>>['plugins'][string] | undefined): boolean {
  if (!state) {
    return false;
  }
  return state.state.enabled === true
    && state.source.kind === 'path'
    && state.source.trustPolicy === 'local_trusted'
    && state.install.mode === 'link';
}

export async function reloadTrustedLocalPluginTool(params: Readonly<{
  happyHomeDir?: string;
  pluginId: string;
  reload?: (params?: Readonly<{ pluginId?: string | null }>) => Promise<ReloadPluginResult>;
}>): Promise<HappierBuiltInToolDispatchResult> {
  const pluginId = params.pluginId.trim();
  if (pluginId.length === 0) {
    return err('invalid_action_input', 'Missing pluginId');
  }

  const store = createPluginStateStore({ happyHomeDir: params.happyHomeDir });
  const state = await store.read();
  const pluginState = state.plugins[pluginId];
  if (!pluginState) {
    return err('plugin_not_found', `Plugin not found: ${pluginId}`);
  }
  if (!isTrustedLocalDevPlugin(pluginState)) {
    return err('plugin_reload_not_allowed', 'Only enabled trusted local dev plugins can be reloaded from the tool bridge');
  }

  const reload = params.reload ?? pluginReloadController.reload;
  const result = await reload({ pluginId });
  if (!result.ok) {
    const message = result.diagnostics[0]?.message ?? `Plugin reload failed for ${pluginId}`;
    return err('plugin_reload_failed', message);
  }

  return {
    ok: true,
    result: {
      pluginId,
      activeGenerationId: result.activeGenerationId,
      changedPluginIds: result.changedPluginIds,
      registryStatus: result.registryStatus,
      diagnostics: result.diagnostics,
    },
  };
}
