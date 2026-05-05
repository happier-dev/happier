import { createPluginStateStore } from './state';

export type SetInstalledPluginEnabledResult =
  | Readonly<{
      ok: true;
      pluginId: string;
      enabled: boolean;
      changed: boolean;
    }>
  | Readonly<{
      ok: false;
      errorCode: 'plugin_not_found';
      errorMessage: string;
    }>;

export async function setInstalledPluginEnabled(params: Readonly<{
  happyHomeDir?: string;
  pluginId: string;
  enabled: boolean;
}>): Promise<SetInstalledPluginEnabledResult> {
  const store = createPluginStateStore({ happyHomeDir: params.happyHomeDir });
  let changed = false;
  let found = false;
  await store.update(async (state) => {
    const record = state.plugins[params.pluginId];
    if (!record) {
      return state;
    }
    found = true;
    changed = record.state.enabled !== params.enabled;
    if (!changed) {
      return state;
    }
    return {
      ...state,
      plugins: {
        ...state.plugins,
        [params.pluginId]: {
          ...record,
          state: {
            ...record.state,
            enabled: params.enabled,
          },
        },
      },
    };
  });

  if (!found) {
    return {
      ok: false,
      errorCode: 'plugin_not_found',
      errorMessage: `Unknown plugin id: ${params.pluginId}`,
    };
  }

  return {
    ok: true,
    pluginId: params.pluginId,
    enabled: params.enabled,
    changed,
  };
}
