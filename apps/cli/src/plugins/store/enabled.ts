import { createPluginRegistryStateStore } from './registry/currentState';
import { describeUserPluginChangeFailure, requestUserPluginChange } from '@/plugins/daemon/changeClient';
import type { ManagedResourceDispositionV1 } from '@happier-dev/protocol/machines/managed/managedDependencyV1';

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
      errorCode: string;
      errorMessage: string;
      change?: Awaited<ReturnType<typeof requestUserPluginChange>>;
    }>;

export async function setInstalledPluginEnabled(params: Readonly<{
  happyHomeDir?: string;
  pluginId: string;
  enabled: boolean;
  managedResourceDispositions?: readonly ManagedResourceDispositionV1[];
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
      request: params.enabled
        ? { kind: 'enable', pluginId: params.pluginId }
        : { kind: 'disable', pluginId: params.pluginId,
            ...(params.managedResourceDispositions !== undefined
              ? { managedResourceDispositions: params.managedResourceDispositions } : {}) },
      approval: 'none',
    });
    if (change.kind !== 'committed') {
      const failure = describeUserPluginChangeFailure(change);
      return { ok: false, errorCode: failure.code, errorMessage: failure.message, change };
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
