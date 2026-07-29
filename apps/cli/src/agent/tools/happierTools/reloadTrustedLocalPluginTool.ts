import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
import { requestUserPluginChange } from '@/plugins/daemon/changeClient';

import type { HappierBuiltInToolDispatchResult } from './types';

function err(errorCode: string, error: string): HappierBuiltInToolDispatchResult {
  return { ok: false, errorCode, error };
}

export async function reloadTrustedLocalPluginTool(params: Readonly<{
  happyHomeDir?: string;
  pluginId: string;
  requestChange?: typeof requestUserPluginChange;
}>): Promise<HappierBuiltInToolDispatchResult> {
  const pluginId = params.pluginId.trim();
  if (pluginId.length === 0) {
    return err('invalid_action_input', 'Missing pluginId');
  }

  const store = createPluginRegistryStateStore({ happyHomeDir: params.happyHomeDir });
  const state = await store.read();
  const pluginState = state.plugins[pluginId];
  if (!pluginState) {
    return err('plugin_not_found', `Plugin not found: ${pluginId}`);
  }
  if (
    !pluginState
    || pluginState.state.enabled !== true
    || pluginState.source.kind !== 'path'
    || pluginState.install.mode !== 'link'
    || !pluginState.source.locator
  ) {
    return err('plugin_reload_not_allowed', 'Only enabled trusted local dev plugins can be reloaded from the tool bridge');
  }

  const result = await (params.requestChange ?? requestUserPluginChange)({
    request: {
      kind: 'development',
      pluginId,
      sourceRootPath: pluginState.source.locator,
    },
    approval: 'none',
  });
  if (result.kind === 'reviewRequired') {
    return err('plugin_reload_not_allowed', 'Only enabled trusted local dev plugins can be reloaded from the tool bridge');
  }
  if (
    result.kind !== 'committed'
    || result.appliedGeneration === null
    || result.appliedGeneration !== result.desiredGeneration
  ) {
    return err('plugin_reload_failed', `Plugin reload failed for ${pluginId} (${result.kind})`);
  }

  return {
    ok: true,
    result: {
      pluginId,
      activeGenerationId: result.appliedGeneration,
      changedPluginIds: [pluginId],
      registryStatus: 'active',
      diagnostics: [],
    },
  };
}
