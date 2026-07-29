import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
import { requestUserPluginChange } from '@/plugins/daemon/changeClient';

export type RemoveInstalledPluginResult =
  | Readonly<{
      ok: true;
      pluginId: string;
      removedInstalledPath: string | null;
      change: Awaited<ReturnType<typeof requestUserPluginChange>>;
    }>
  | Readonly<{
      ok: false;
      errorCode:
        | 'plugin_not_found'
        | 'plugin_not_uninstallable'
        | 'plugin_change_review_required'
        | 'plugin_change_busy'
        | 'plugin_change_unavailable'
        | 'plugin_change_conflict'
        | 'plugin_change_failed'
        | 'plugin_change_outcome_unknown'
        | 'plugin_change_cancelled'
        | 'plugin_change_expired';
      errorMessage: string;
    }>;

export async function removeInstalledPlugin(params: Readonly<{
  happyHomeDir: string;
  pluginId: string;
}>): Promise<RemoveInstalledPluginResult> {
  const store = createPluginRegistryStateStore({ happyHomeDir: params.happyHomeDir });
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

  const change = await requestUserPluginChange({
    request: { kind: 'uninstall', pluginId: params.pluginId },
    approval: 'none',
  });
  if (change.kind !== 'committed') {
    const normalizedKind = change.kind === 'reviewRequired' ? 'review_required' : change.kind;
    return {
      ok: false,
      errorCode: `plugin_change_${normalizedKind}` as Extract<RemoveInstalledPluginResult, { ok: false }>['errorCode'],
      errorMessage: `The daemon did not commit plugin uninstall (${change.kind}).`,
    };
  }

  return {
    ok: true,
    pluginId: params.pluginId,
    removedInstalledPath: record.install.installedPath ?? null,
    change,
  };
}
