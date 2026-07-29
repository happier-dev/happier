import * as React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { PluginUiRenderContext } from '@happier-dev/plugin-sdk/ui';

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
 * Generated renderers receive the canonical public Plugin UI render context.
 * The Inspector declares and uses only `executeAction`; the host owns its wire
 * adaptation and action-executor routing.
 */

export type InspectorRenderSurfaceContext = PluginUiRenderContext;

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

export function InspectorSurface({ hostApi, surface }: InspectorRenderSurfaceContext): React.ReactElement {
  const [plugins, setPlugins] = React.useState<readonly InspectorPluginSummary[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [reloadingPluginId, setReloadingPluginId] = React.useState<string | null>(null);
  const [lastReload, setLastReload] = React.useState<InspectorReloadSummary | null>(null);
  const styles = React.useMemo(
    () => createInspectorStyles(surface),
    [surface?.colorScheme, surface?.contrast, surface?.direction],
  );

  const refreshPluginList = React.useCallback(async () => {
    if (!hostApi) {
      setError('host_api_unavailable');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await hostApi.executeAction('plugins.list', {});
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
      const result = await hostApi.executeAction(
        'plugins.reload',
        pluginId ? { pluginId } : {},
      );
      setLastReload(readReloadResult(result));
      // The reload action result is the canonical completion signal. Refetch
      // the list from that result instead of adding a second event path for
      // the same information.
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
        <Text accessibilityRole="header" style={styles.title}>Plugin Inspector</Text>
        <Pressable
          testID="inspector-reload-all"
          disabled={reloadingPluginId !== null}
          accessibilityRole="button"
          accessibilityLabel="Reload all plugins"
          accessibilityState={{ disabled: reloadingPluginId !== null }}
          onPress={() => { void reloadPlugin(undefined); }}
          style={styles.reloadAllButton}
        >
          <Text style={styles.reloadAllLabel}>{reloadingPluginId === '*' ? 'Reloading…' : 'Reload all'}</Text>
        </Pressable>
      </View>

      {lastReload ? (
        <View
          testID="inspector-last-reload"
          accessibilityLiveRegion="polite"
          style={styles.reloadSummary}
        >
          <Text style={styles.reloadSummaryText}>
            {lastReload.ok ? 'Last reload succeeded' : 'Last reload failed'}
            {lastReload.registryStatus ? ` — registry: ${lastReload.registryStatus}` : ''}
          </Text>
          {lastReload.changedPluginIds && lastReload.changedPluginIds.length > 0 ? (
            <Text style={styles.reloadSummaryText}>Changed: {lastReload.changedPluginIds.join(', ')}</Text>
          ) : null}
        </View>
      ) : null}

      {error ? (
        <Text
          testID="inspector-error"
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
          style={styles.errorText}
        >
          {error}
        </Text>
      ) : null}
      {loading && !plugins ? (
        <Text accessibilityLiveRegion="polite" style={styles.emptyText}>Loading…</Text>
      ) : null}
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
            accessibilityRole="button"
            accessibilityLabel={`Reload ${plugin.title ?? plugin.pluginId}`}
            accessibilityState={{ disabled: reloadingPluginId !== null }}
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

function createInspectorStyles(surface: InspectorRenderSurfaceContext['surface'] | undefined) {
  const dark = surface?.colorScheme === 'dark';
  const highContrast = surface?.contrast === 'high';
  const rtl = surface?.direction === 'rtl';
  const colors = highContrast
    ? dark
      ? {
          background: '#000000',
          text: '#ffffff',
          secondaryText: '#ffffff',
          error: '#ffff00',
          border: '#ffffff',
          buttonBackground: '#ffffff',
          buttonText: '#000000',
          summaryBackground: '#000000',
        }
      : {
          background: '#ffffff',
          text: '#000000',
          secondaryText: '#000000',
          error: '#b00020',
          border: '#000000',
          buttonBackground: '#000000',
          buttonText: '#ffffff',
          summaryBackground: '#ffffff',
        }
    : dark
      ? {
          background: '#111827',
          text: '#f9fafb',
          secondaryText: '#d1d5db',
          error: '#fca5a5',
          border: '#9ca3af',
          buttonBackground: '#2563eb',
          buttonText: '#ffffff',
          summaryBackground: '#1e3a5f',
        }
      : {
          background: '#ffffff',
          text: '#111827',
          secondaryText: '#374151',
          error: '#b91c1c',
          border: '#6b7280',
          buttonBackground: '#2563eb',
          buttonText: '#ffffff',
          summaryBackground: '#dbeafe',
        };
  const writingDirection = rtl ? 'rtl' as const : 'ltr' as const;

  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
      writingDirection,
    },
    content: {
      padding: 12,
      gap: 8,
    },
    header: {
      flexDirection: rtl ? 'row-reverse' : 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
    },
    title: {
      color: colors.text,
      fontSize: 15,
      fontWeight: '600',
      writingDirection,
    },
    reloadAllButton: {
      minHeight: 48,
      minWidth: 48,
      paddingHorizontal: 12,
      paddingVertical: 8,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 6,
      borderWidth: highContrast ? 2 : 0,
      borderColor: colors.border,
      backgroundColor: colors.buttonBackground,
    },
    reloadAllLabel: {
      color: colors.buttonText,
      fontSize: 12,
      fontWeight: '600',
      writingDirection,
    },
    reloadSummary: {
      padding: 8,
      borderRadius: 6,
      borderWidth: highContrast ? 2 : 0,
      borderColor: colors.border,
      backgroundColor: colors.summaryBackground,
    },
    reloadSummaryText: {
      color: colors.text,
      fontSize: 12,
      writingDirection,
    },
    errorText: {
      fontSize: 12,
      color: colors.error,
      writingDirection,
    },
    emptyText: {
      fontSize: 12,
      color: colors.secondaryText,
      writingDirection,
    },
    pluginRow: {
      flexDirection: rtl ? 'row-reverse' : 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
      paddingVertical: 8,
      borderBottomWidth: highContrast ? 2 : StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    pluginInfo: {
      flex: 1,
      flexShrink: 1,
      minWidth: 160,
      gap: 2,
    },
    pluginTitle: {
      color: colors.text,
      fontSize: 13,
      fontWeight: '600',
      writingDirection,
    },
    pluginMeta: {
      color: colors.secondaryText,
      fontSize: 11,
      writingDirection,
    },
    pluginDiagnostics: {
      fontSize: 11,
      color: colors.error,
      writingDirection,
    },
    reloadButton: {
      minHeight: 48,
      minWidth: 48,
      paddingHorizontal: 10,
      paddingVertical: 8,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 6,
      borderWidth: highContrast ? 2 : StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.background,
    },
    reloadLabel: {
      color: colors.text,
      fontSize: 11,
      fontWeight: '600',
      writingDirection,
    },
  });
}
