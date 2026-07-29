import { createPluginRegistryStateStore } from './registry/currentState';
import { requestUserPluginChange } from '@/plugins/daemon/changeClient';

type PluginChangeFailureCode =
  | 'plugin_change_review_required'
  | 'plugin_change_busy'
  | 'plugin_change_unavailable'
  | 'plugin_change_conflict'
  | 'plugin_change_failed'
  | 'plugin_change_outcome_unknown'
  | 'plugin_change_cancelled'
  | 'plugin_change_expired';

export type SetInstalledPluginEnabledResult =
  | Readonly<{
      ok: true;
      pluginId: string;
      enabled: boolean;
      changed: boolean;
      change?: Awaited<ReturnType<typeof requestUserPluginChange>>;
    }>
  | Readonly<{
      ok: false;
      errorCode: 'plugin_not_found' | PluginChangeFailureCode;
      errorMessage: string;
    }>;

function describePluginChangeFailure(kind: string): Readonly<{
  errorCode: PluginChangeFailureCode;
  errorMessage: string;
}> {
  const normalizedKind = kind === 'reviewRequired' ? 'review_required' : kind;
  return {
    errorCode: `plugin_change_${normalizedKind}` as PluginChangeFailureCode,
    errorMessage: `The daemon did not commit the plugin state change (${kind}).`,
  };
}

export async function setInstalledPluginEnabled(params: Readonly<{
  happyHomeDir?: string;
  pluginId: string;
  enabled: boolean;
}>): Promise<SetInstalledPluginEnabledResult> {
  const store = createPluginRegistryStateStore({ happyHomeDir: params.happyHomeDir });
  const record = (await store.read()).plugins[params.pluginId];
  if (!record) {
    return {
      ok: false,
      errorCode: 'plugin_not_found',
      errorMessage: `Unknown plugin id: ${params.pluginId}`,
    };
  }

  const changed = record.state.enabled !== params.enabled;
  let committedChange: Awaited<ReturnType<typeof requestUserPluginChange>> | undefined;
  if (changed) {
    const change = await requestUserPluginChange({
      request: { kind: params.enabled ? 'enable' : 'disable', pluginId: params.pluginId },
      approval: 'none',
    });
    if (change.kind !== 'committed') {
      return { ok: false, ...describePluginChangeFailure(change.kind) };
    }
    committedChange = change;
  }

  return {
    ok: true,
    pluginId: params.pluginId,
    enabled: params.enabled,
    changed,
    ...(committedChange ? { change: committedChange } : {}),
  };
}
