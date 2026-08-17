import * as React from 'react';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import {
  Action,
  ActionPanel,
  Banner,
  BrandMark,
  Button,
  CodeBlock,
  ContextMenu,
  EmptyState,
  Icon,
  IconButton,
  Image,
  Item,
  ItemGroup,
  List,
  type ListHeaderContext,
  LoadingState,
  Markdown,
  Menu,
  Popover,
  Progress,
  Row,
  ScrollArea,
  Stack,
  Status,
  Text,
  defineUiSurface,
  usePluginTheme,
  useSurfaceContext,
} from '@happier-dev/plugin-ui';

// This is a bundled TSX entry. Unlike the daemon's emitted Node modules, the
// Re.Pack/Vite source resolver needs the extensionless TypeScript module path.
// The manifest remains the one owner of the action id.
import {
  INSPECTOR_INVENTORY_ILLUSTRATION_RESOURCE_ID,
  INSPECTOR_PLUGIN_ID,
  INSPECTOR_SELF_CHECK_ACTION_ID,
} from '../manifest';

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

export type InspectorRenderSurfaceContext = RenderContext;

type InspectorPluginDiagnostic = Readonly<{ code?: string; message?: string }>;

type InspectorPluginSummary = Readonly<{
  pluginId: string;
  version?: string;
  title?: string;
  enabled: boolean;
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
    && typeof (value as { pluginId?: unknown }).pluginId === 'string'
    && typeof (value as { enabled?: unknown }).enabled === 'boolean';
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

function inspectorPluginLabel(plugin: InspectorPluginSummary): string {
  return plugin.title ?? plugin.pluginId;
}

function keyForInspectorPlugin(plugin: InspectorPluginSummary): string {
  return plugin.pluginId;
}

function inspectorPluginStatus(plugin: InspectorPluginSummary): 'enabled' | 'disabled' {
  return plugin.enabled ? 'enabled' : 'disabled';
}

const INSPECTOR_INVENTORY_ILLUSTRATION_RESOURCE = {
  pluginId: INSPECTOR_PLUGIN_ID,
  localId: INSPECTOR_INVENTORY_ILLUSTRATION_RESOURCE_ID,
} as const;

/**
 * Inspector owns its plugin-specific match semantics; the public List owns
 * query state and filters the supplied inventory before virtualization.
 */
function matchesInspectorPlugin(
  plugin: InspectorPluginSummary,
  search: string,
): boolean {
  const normalizedSearch = search.trim().toLocaleLowerCase();
  return normalizedSearch === '' || [
    inspectorPluginLabel(plugin),
    plugin.pluginId,
    inspectorPluginStatus(plugin),
  ].some((value) => value.toLocaleLowerCase().includes(normalizedSearch));
}

export function InspectorSurface({ hostApi, surface, subPath }: InspectorRenderSurfaceContext): React.ReactElement {
  const [plugins, setPlugins] = React.useState<readonly InspectorPluginSummary[] | null>(null);
  const [selectedPluginId, setSelectedPluginId] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [reloadingPluginId, setReloadingPluginId] = React.useState<string | null>(null);
  const [lastReload, setLastReload] = React.useState<InspectorReloadSummary | null>(null);
  const [quickActionsMenuOpen, setQuickActionsMenuOpen] = React.useState(false);
  const [selfCheckPopoverOpen, setSelfCheckPopoverOpen] = React.useState(false);
  const [quickActionsContextMenuOpen, setQuickActionsContextMenuOpen] = React.useState(false);
  const surfaceContext = useSurfaceContext();
  const theme = usePluginTheme();
  // §3.2: the host projects this plugin's own translation bundle for the active
  // locale onto the surface, already merged over its English fallback. The
  // surface resolves keys synchronously and owns no string catalog; an author
  // fallback is always supplied so an unknown key never renders raw.
  const text = React.useCallback(
    (key: string, fallback: string) => surfaceContext.translations[key] ?? fallback,
    [surfaceContext.translations],
  );

  // EU-5b: the host owns the route; the plugin owns everything under it. On the
  // page placement the surface reads its own location from `subPath` and moves
  // between locations through `openSurface`, so the user's back/forward walks
  // this surface's own navigation.
  const onPage = surface.mount.kind === 'destination'
    && surface.mount.container === 'appPage';
  const canOpenSurface = Boolean(hostApi) && hostApi.version().methods.includes('openSurface');
  const openLocation = React.useCallback(async (nextSubPath: string) => {
    if (!canOpenSurface) return;
    setError(null);
    try {
      await hostApi.openSurface('inspector-page', undefined, { subPath: nextSubPath });
    } catch (requestError) {
      setError(readErrorMessage(requestError));
    }
  }, [canOpenSurface, hostApi]);

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

  const reloadPlugin = React.useCallback(async (pluginId: string) => {
    if (!hostApi) {
      setError('host_api_unavailable');
      return;
    }
    setReloadingPluginId(pluginId);
    setError(null);
    try {
      const result = await hostApi.executeAction(
        'plugins.reload',
        { pluginId },
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

  const quickActionItems = React.useMemo(() => [{
    id: 'refresh',
    label: text('plugins.inspector.surface.refresh', 'Refresh plugin inventory'),
  }], [text]);
  const selectQuickAction = React.useCallback((id: string) => {
    if (id === 'refresh') {
      void refreshPluginList();
    }
  }, [refreshPluginList]);

  const rowDirection = surfaceContext.direction === 'rtl' ? 'row-reverse' : 'row';
  const renderPluginRow = React.useCallback((plugin: InspectorPluginSummary) => (
    <List.Item
      testID={`inspector-plugin-${plugin.pluginId}`}
      accessibilityLabel={inspectorPluginLabel(plugin)}
      showDivider
    >
      <Row gap="small" wrap align="center" justify="space-between" style={{ flexDirection: rowDirection }}>
        <Stack gap="xsmall" style={{ flex: 1, minWidth: 0 }}>
          <Text value={inspectorPluginLabel(plugin)} variant="label" />
          <Text
            value={`${plugin.pluginId}${plugin.version ? ` · v${plugin.version}` : ''} · ${inspectorPluginStatus(plugin)}`}
            variant="caption"
            tone="secondary"
          />
          {(plugin.diagnostics ?? []).length > 0 ? (
            <Markdown
              value={(plugin.diagnostics ?? [])
                .map((diagnostic) => `- ${diagnostic.message ?? diagnostic.code ?? 'diagnostic'}`)
                .join('\n')}
              testID={`inspector-diagnostics-${plugin.pluginId}`}
            />
          ) : null}
        </Stack>
      </Row>
    </List.Item>
  ), [rowDirection]);

  const surfaceHeader = (
    <>
        <Row gap="small" wrap align="center" justify="space-between" style={{ flexDirection: rowDirection }}>
          <BrandMark
            size="small"
            showName
          />
          <Image
            resource={INSPECTOR_INVENTORY_ILLUSTRATION_RESOURCE}
            size="small"
            accessibilityLabel={text(
              'plugins.inspector.surface.inventoryIllustration',
              'Plugin inventory illustration',
            )}
            fallback="PI"
            testID="inspector-inventory-illustration"
          />
          <Menu
            testID="inspector-quick-actions-menu"
            open={quickActionsMenuOpen}
            onOpenChange={setQuickActionsMenuOpen}
            trigger={text('plugins.inspector.surface.showActions', 'Inspector actions')}
            triggerTextVariant="caption"
            triggerTextTone="muted"
            triggerAccessibilityLabel={text('plugins.inspector.surface.showActions', 'Inspector actions')}
            items={quickActionItems}
            onSelect={selectQuickAction}
          />
          <Popover
            testID="inspector-self-check-popover"
            open={selfCheckPopoverOpen}
            onOpenChange={setSelfCheckPopoverOpen}
            trigger={text('plugins.inspector.surface.selfCheck', 'Run Inspector self-check')}
            triggerTextVariant="caption"
            triggerTextTone="muted"
            triggerAccessibilityLabel={text('plugins.inspector.surface.selfCheck', 'Run Inspector self-check')}
            contentAccessibilityLabel={text('plugins.inspector.surface.selfCheck', 'Run Inspector self-check')}
          >
            <Text
              value={text('plugins.inspector.surface.selfCheckDescription', 'Verify the Inspector action bridge.')}
              variant="caption"
              tone="secondary"
            />
            <Action.Execute
              testID="inspector-self-check-action"
              action={INSPECTOR_SELF_CHECK_ACTION_ID}
              title={text('plugins.inspector.surface.selfCheck', 'Run Inspector self-check')}
            />
          </Popover>
          <ContextMenu
            testID="inspector-quick-actions-context-menu"
            open={quickActionsContextMenuOpen}
            onOpenChange={setQuickActionsContextMenuOpen}
            trigger={text('plugins.inspector.surface.showActions', 'Inspector actions')}
            triggerTextVariant="caption"
            triggerTextTone="muted"
            triggerAccessibilityLabel={text('plugins.inspector.surface.showActionsContext', 'Open Inspector context actions')}
            items={quickActionItems}
            onSelect={selectQuickAction}
          />
        </Row>

        {canOpenSurface ? (
          <Row gap="small" wrap align="center" style={{ flexDirection: rowDirection }}>
            <Button
              testID={onPage ? 'inspector-open-diagnostics' : 'inspector-open-page'}
              title={onPage
                ? text('plugins.inspector.surface.openDiagnostics', 'Open diagnostics')
                : text('plugins.inspector.surface.openPage', 'Open full page')}
              onPress={() => { void openLocation(onPage ? 'diagnostics' : ''); }}
            />
          </Row>
        ) : null}

        {onPage ? (
          <Text
            testID="inspector-location"
            value={subPath && subPath.length > 0
              ? subPath
              : text('plugins.inspector.surface.pageRoot', 'Page root')}
            variant="caption"
            tone="secondary"
          />
        ) : null}

        {lastReload ? (
          <Stack testID="inspector-last-reload" gap="small">
            <Status
              tone={lastReload.ok ? 'success' : 'danger'}
              label={`${lastReload.ok
                ? text('plugins.inspector.surface.reloadSucceeded', 'Last reload succeeded')
                : text('plugins.inspector.surface.reloadFailed', 'Last reload failed')}${lastReload.registryStatus ? ` — registry: ${lastReload.registryStatus}` : ''}`}
            />
            {lastReload.changedPluginIds && lastReload.changedPluginIds.length > 0 ? (
              <Text value={`Changed: ${lastReload.changedPluginIds.join(', ')}`} />
            ) : null}
            <CodeBlock
              code={JSON.stringify(lastReload, null, 2)}
              language="json"
              copyLabel={text('plugins.inspector.surface.copyReload', 'Copy reload details')}
              testID="inspector-last-reload-json"
            />
          </Stack>
        ) : null}

        {error ? (
          <Banner
            testID="inspector-error"
            tone="danger"
            title={error}
          />
        ) : null}
        {loading && !plugins ? (
          <LoadingState
            title={text('plugins.inspector.surface.loading', 'Loading…')}
          />
        ) : null}
        {loading && plugins ? (
          <Progress
            testID="inspector-refresh-progress"
            label={text('plugins.inspector.surface.refreshing', 'Refreshing plugin inventory')}
          />
        ) : null}
        {plugins && plugins.length === 0 && !loading ? (
          <EmptyState
            title={text('plugins.inspector.surface.empty', 'No plugins installed.')}
          />
        ) : null}
    </>
  );

  const surfaceFooter = (
    <>
        <List accessibilityLabel={text('plugins.inspector.surface.quickActions', 'Inspector quick actions')}>
          <List.Section title={text('plugins.inspector.surface.inventoryActions', 'Inventory actions')}>
            <ItemGroup accessibilityLabel={text('plugins.inspector.surface.quickActions', 'Inspector quick actions')}>
              <Item
                title={text('plugins.inspector.surface.refresh', 'Refresh plugin inventory')}
                subtitle={text('plugins.inspector.surface.refreshHint', 'Reads the current admitted plugin list')}
                onPress={() => { void refreshPluginList(); }}
              />
              <IconButton
                accessibilityLabel={text('plugins.inspector.surface.refresh', 'Refresh plugin inventory')}
                icon={<Icon name="refresh" />}
                busy={loading}
                onPress={() => refreshPluginList()}
              />
            </ItemGroup>
          </List.Section>
        </List>
        <ActionPanel title={text('plugins.inspector.surface.quickActions', 'Inspector quick actions')}>
          <ActionPanel.Section title={text('plugins.inspector.surface.inventoryActions', 'Inventory actions')}>
            <Action.Execute
              action="plugins.list"
              input={{}}
              title={text('plugins.inspector.surface.refresh', 'Refresh plugin inventory')}
            />
            <Action.Copy
              value={JSON.stringify(plugins ?? [], null, 2)}
              title="Copy plugin inventory"
            />
            <Action.Refresh
              onRefresh={refreshPluginList}
              title={text('plugins.inspector.surface.refresh', 'Refresh plugin inventory')}
            />
          </ActionPanel.Section>
          <ActionPanel.Section title={text('plugins.inspector.surface.navigationActions', 'Inspector navigation')}>
            <Action.OpenExternal
              url="https://happier.dev/docs/plugins"
              title="Open plugin documentation"
            />
            {canOpenSurface ? (
              <Action.OpenSurface
                view="inspector-page"
                input={{ source: 'inspector-action-panel' }}
                title="Open inspector page"
              />
            ) : null}
          </ActionPanel.Section>
        </ActionPanel>
    </>
  );

  if (plugins && plugins.length > 0) {
    return (
      <List<InspectorPluginSummary>
        testID="inspector-surface"
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: theme.spacing.medium }}
        items={plugins}
        keyForItem={keyForInspectorPlugin}
        renderItem={renderPluginRow}
        accessibilityLabel={text('plugins.inspector.surface.inventory', 'Installed plugins')}
        search={{
          testID: 'inspector-plugin-search',
          label: text('plugins.inspector.surface.search', 'Search installed plugins'),
          placeholder: text('plugins.inspector.surface.searchPlaceholder', 'Search by name or plugin ID'),
          filter: matchesInspectorPlugin,
        }}
        selection={{
          selectedKey: selectedPluginId,
          onSelectedKeyChange: setSelectedPluginId,
        }}
        header={({ selectedItem }: ListHeaderContext<InspectorPluginSummary>) => (
          <Stack gap="small">
            {surfaceHeader}
            {selectedItem ? (
              <Button
                testID={`inspector-reload-selected-${selectedItem.pluginId}`}
                disabled={reloadingPluginId !== null}
                title={reloadingPluginId === selectedItem.pluginId
                  ? text('plugins.inspector.surface.reloading', 'Reloading…')
                  : `${text('plugins.inspector.surface.reload', 'Reload')} ${inspectorPluginLabel(selectedItem)}`}
                onPress={() => { void reloadPlugin(selectedItem.pluginId); }}
              />
            ) : null}
          </Stack>
        )}
        empty={(
          <EmptyState
            testID="inspector-plugin-search-empty"
            title={text('plugins.inspector.surface.noMatches', 'No matching plugins')}
            description={text(
              'plugins.inspector.surface.noMatchesDescription',
              'Try a different name or plugin ID.',
            )}
          />
        )}
        footer={<Stack gap="small">{surfaceFooter}</Stack>}
      />
    );
  }

  return (
    <ScrollArea
      testID="inspector-surface"
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: theme.spacing.medium }}
    >
      <Stack gap="small">
        {surfaceHeader}
        {surfaceFooter}
      </Stack>
    </ScrollArea>
  );
}

export const renderSurface = defineUiSurface(InspectorSurface);
