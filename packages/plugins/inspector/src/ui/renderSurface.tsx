import * as React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

/**
 * RN-DOGFOOD: the inspector's ONE RN-authored surface, rendered on BOTH web
 * (via `packages/plugin-sdk`'s `defineReactNativeWebViteBuildPreset`, a Vite
 * + react-native-web build of THIS SAME file) and native (via
 * `defineReactNativeRepackBuildPreset`, a Re.Pack build of THIS SAME file) —
 * `renderSurface` is the ONE bundle-contract export both build targets ship,
 * per LEDGER DEC-6 ("ship one sourceEntry, get all platforms").
 *
 * This replaces the previous `hostedWeb` surface (`INSPECTOR_APP_HOSTED_WEB`
 * in `../manifest.ts`), which shipped a manifest reference to a static HTML
 * artifact with no real source checked into this repo — an inert stub, not a
 * working inspector UI. See `../manifest.ts`'s module doc for the retirement
 * rationale.
 *
 * Host API contract: `context.hostApi` is the SAME `dispatchAction`-shaped
 * object every `reactNative`-mode surface receives (native props injection
 * AND the new `@happier-dev/plugin-sdk/ui/hostApiClient` direct-import
 * carrier — RN-DOGFOOD item 1, LEDGER DEC-7 — both resolve to this identical
 * shape). This file only depends on the minimal duck-typed slice it actually
 * calls, not a host-internal type, per the plugin-authoring package boundary
 * (no `@/` imports, no host chrome).
 */

export type InspectorRenderSurfaceHostApi = Readonly<{
  dispatchAction: (payload: Readonly<{ actionId: string; input?: unknown }>) => Promise<unknown>;
}>;

export type InspectorRenderSurfaceContext = Readonly<{
  surface?: Readonly<{ pluginId?: string }>;
  hostApi?: InspectorRenderSurfaceHostApi;
}>;

type InspectorPluginDiagnostic = Readonly<{ code?: string; message?: string }>;

type InspectorPluginSummary = Readonly<{
  id: string;
  pluginId: string;
  version?: string;
  title?: string;
  state: 'enabled' | 'disabled';
  sourceKind?: string;
  contributions?: readonly string[];
  diagnostics?: readonly InspectorPluginDiagnostic[];
}>;

type InspectorReloadSummary = Readonly<{
  ok: boolean;
  generation?: number | null;
  changedPluginIds?: readonly string[];
  affectedPluginIds?: readonly string[];
  registryStatus?: string | null;
  diagnostics?: readonly InspectorPluginDiagnostic[];
}>;

function isPluginSummary(value: unknown): value is InspectorPluginSummary {
  return Boolean(value) && typeof value === 'object'
    && typeof (value as { pluginId?: unknown }).pluginId === 'string';
}

function readPluginsListResult(result: unknown): readonly InspectorPluginSummary[] {
  if (!result || typeof result !== 'object') {
    return [];
  }
  const plugins = (result as { plugins?: unknown }).plugins;
  return Array.isArray(plugins) ? plugins.filter(isPluginSummary) : [];
}

function readReloadResult(result: unknown): InspectorReloadSummary | null {
  if (!result || typeof result !== 'object') {
    return null;
  }
  const record = result as Record<string, unknown>;
  if (typeof record.ok !== 'boolean') {
    return null;
  }
  return {
    ok: record.ok,
    generation: typeof record.generation === 'number' ? record.generation : null,
    changedPluginIds: Array.isArray(record.changedPluginIds) ? record.changedPluginIds as readonly string[] : [],
    affectedPluginIds: Array.isArray(record.affectedPluginIds) ? record.affectedPluginIds as readonly string[] : [],
    registryStatus: typeof record.registryStatus === 'string' ? record.registryStatus : null,
    diagnostics: Array.isArray(record.diagnostics) ? record.diagnostics as readonly InspectorPluginDiagnostic[] : [],
  };
}

function readErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return 'plugin_inspector_request_failed';
}

export function InspectorSurface({ hostApi }: InspectorRenderSurfaceContext): React.ReactElement {
  const [plugins, setPlugins] = React.useState<readonly InspectorPluginSummary[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [reloadingPluginId, setReloadingPluginId] = React.useState<string | null>(null);
  const [lastReload, setLastReload] = React.useState<InspectorReloadSummary | null>(null);

  const refreshPluginList = React.useCallback(async () => {
    if (!hostApi) {
      setError('host_api_unavailable');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await hostApi.dispatchAction({ actionId: 'plugins.list' });
      setPlugins(readPluginsListResult(result));
    } catch (requestError) {
      setError(readErrorMessage(requestError));
    } finally {
      setLoading(false);
    }
  }, [hostApi]);

  React.useEffect(() => {
    void refreshPluginList();
  }, [refreshPluginList]);

  const reloadPlugin = React.useCallback(async (pluginId?: string) => {
    if (!hostApi) {
      setError('host_api_unavailable');
      return;
    }
    setReloadingPluginId(pluginId ?? '*');
    setError(null);
    try {
      const result = await hostApi.dispatchAction({
        actionId: 'plugins.reload',
        input: pluginId ? { pluginId } : {},
      });
      setLastReload(readReloadResult(result));
      // Live update: the reload action result already carries the SAME
      // changed/affected-plugin-id + diagnostics summary the daemon-side
      // `plugin.reload.after` hook observes (see `../activate.ts`) — refetch
      // the list rather than adding a second, separately-delivered event
      // path for the same information.
      await refreshPluginList();
    } catch (requestError) {
      setError(readErrorMessage(requestError));
    } finally {
      setReloadingPluginId(null);
    }
  }, [hostApi, refreshPluginList]);

  return (
    <ScrollView testID="inspector-surface" style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text style={styles.title}>Plugin Inspector</Text>
        <Pressable
          testID="inspector-reload-all"
          disabled={reloadingPluginId !== null}
          onPress={() => { void reloadPlugin(undefined); }}
          style={styles.reloadAllButton}
        >
          <Text style={styles.reloadAllLabel}>{reloadingPluginId === '*' ? 'Reloading…' : 'Reload all'}</Text>
        </Pressable>
      </View>

      {lastReload ? (
        <View testID="inspector-last-reload" style={styles.reloadSummary}>
          <Text style={styles.reloadSummaryText}>
            {lastReload.ok ? 'Last reload succeeded' : 'Last reload failed'}
            {lastReload.registryStatus ? ` — registry: ${lastReload.registryStatus}` : ''}
          </Text>
          {lastReload.changedPluginIds && lastReload.changedPluginIds.length > 0 ? (
            <Text style={styles.reloadSummaryText}>Changed: {lastReload.changedPluginIds.join(', ')}</Text>
          ) : null}
        </View>
      ) : null}

      {error ? <Text testID="inspector-error" style={styles.errorText}>{error}</Text> : null}
      {loading && !plugins ? <Text style={styles.emptyText}>Loading…</Text> : null}
      {plugins && plugins.length === 0 && !loading ? <Text style={styles.emptyText}>No plugins installed.</Text> : null}

      {(plugins ?? []).map((plugin) => (
        <View key={plugin.pluginId} testID={`inspector-plugin-${plugin.pluginId}`} style={styles.pluginRow}>
          <View style={styles.pluginInfo}>
            <Text style={styles.pluginTitle}>{plugin.title ?? plugin.pluginId}</Text>
            <Text style={styles.pluginMeta}>
              {plugin.pluginId}
              {plugin.version ? ` · v${plugin.version}` : ''}
              {` · ${plugin.state}`}
            </Text>
            {(plugin.diagnostics ?? []).length > 0 ? (
              <Text style={styles.pluginDiagnostics}>
                {(plugin.diagnostics ?? []).map((diagnostic) => diagnostic.message ?? diagnostic.code ?? 'diagnostic').join('; ')}
              </Text>
            ) : null}
          </View>
          <Pressable
            testID={`inspector-reload-${plugin.pluginId}`}
            disabled={reloadingPluginId !== null}
            onPress={() => { void reloadPlugin(plugin.pluginId); }}
            style={styles.reloadButton}
          >
            <Text style={styles.reloadLabel}>{reloadingPluginId === plugin.pluginId ? 'Reloading…' : 'Reload'}</Text>
          </Pressable>
        </View>
      ))}
    </ScrollView>
  );
}

export function renderSurface(context: InspectorRenderSurfaceContext): React.ReactElement {
  return <InspectorSurface {...context} />;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: 12,
    gap: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
  },
  reloadAllButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: '#2563eb',
  },
  reloadAllLabel: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '600',
  },
  reloadSummary: {
    padding: 8,
    borderRadius: 6,
    backgroundColor: 'rgba(37, 99, 235, 0.08)',
  },
  reloadSummaryText: {
    fontSize: 12,
  },
  errorText: {
    fontSize: 12,
    color: '#dc2626',
  },
  emptyText: {
    fontSize: 12,
    opacity: 0.6,
  },
  pluginRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(0,0,0,0.1)',
  },
  pluginInfo: {
    flex: 1,
    gap: 2,
  },
  pluginTitle: {
    fontSize: 13,
    fontWeight: '600',
  },
  pluginMeta: {
    fontSize: 11,
    opacity: 0.7,
  },
  pluginDiagnostics: {
    fontSize: 11,
    color: '#dc2626',
  },
  reloadButton: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(0,0,0,0.2)',
  },
  reloadLabel: {
    fontSize: 11,
    fontWeight: '600',
  },
});
