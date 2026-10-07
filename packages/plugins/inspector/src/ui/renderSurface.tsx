import * as React from 'react';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import {
  Action,
  ActionPanel,
  Banner,
  BrandMark,
  Button,
  Card,
  CodeBlock,
  ContextMenu,
  EmptyState,
  Heading,
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
  PageHeader,
  Progress,
  Row,
  ScrollArea,
  Stack,
  Status,
  Text,
  defineUiSurface,
  usePluginTheme,
  usePluginTranslation,
  useSurfaceContext,
} from '@happier-dev/plugin-ui';

// The manifest remains the one owner of the action id.
import {
  INSPECTOR_INVENTORY_ILLUSTRATION_RESOURCE_ID,
  INSPECTOR_PLUGIN_ID,
  INSPECTOR_SELF_CHECK_ACTION_ID,
} from '../manifest';
import { readInspectorSelfCheckStatus, type InspectorSelfCheckSettlement } from './selfCheckStatus.js';

/**
 * RN-DOGFOOD: the inspector's one RN-authored surface is compiled once as
 * universal CommonJS and evaluated by the web, iOS, and Android hosts.
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

type InspectorSurfaceError =
  | Readonly<{ kind: 'inventory'; message: string }>
  | Readonly<{ kind: 'navigation'; message: string; subPath: string }>
  | Readonly<{ kind: 'reload'; message: string; pluginId: string }>;

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
  const [error, setError] = React.useState<InspectorSurfaceError | null>(null);
  const [reloadingPluginId, setReloadingPluginId] = React.useState<string | null>(null);
  const [lastReload, setLastReload] = React.useState<InspectorReloadSummary | null>(null);
  const [quickActionsMenuOpen, setQuickActionsMenuOpen] = React.useState(false);
  const [selfCheckSettlement, setSelfCheckSettlement] = React.useState<InspectorSelfCheckSettlement>('not-run');
  const [quickActionsContextMenuOpen, setQuickActionsContextMenuOpen] = React.useState(false);
  const surfaceContext = useSurfaceContext();
  const theme = usePluginTheme();
  // §3.2: built-in and external authors use the same public translation seam,
  // including bounded interpolation of host-projected plugin messages.
  const text = usePluginTranslation();

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
      setError({ kind: 'navigation', message: readErrorMessage(requestError), subPath: nextSubPath });
    }
  }, [canOpenSurface, hostApi]);

  const refreshPluginList = React.useCallback(async () => {
    if (!hostApi) {
      setError({ kind: 'inventory', message: 'host_api_unavailable' });
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await hostApi.executeAction('plugins.list', {});
      setPlugins(readPluginsListResult(result));
    } catch (requestError) {
      setError({ kind: 'inventory', message: readErrorMessage(requestError) });
    } finally {
      setLoading(false);
    }
  }, [hostApi]);

  React.useEffect(() => {
    void refreshPluginList();
  }, [refreshPluginList]);

  const reloadPlugin = React.useCallback(async (pluginId: string) => {
    if (!hostApi) {
      setError({ kind: 'reload', message: 'host_api_unavailable', pluginId });
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
      setError({ kind: 'reload', message: readErrorMessage(requestError), pluginId });
    } finally {
      setReloadingPluginId(null);
    }
  }, [hostApi, refreshPluginList]);

  const retryError = React.useCallback(() => {
    if (!error) return;
    if (error.kind === 'inventory') {
      void refreshPluginList();
      return;
    }
    if (error.kind === 'navigation') {
      void openLocation(error.subPath);
      return;
    }
    void reloadPlugin(error.pluginId);
  }, [error, openLocation, refreshPluginList, reloadPlugin]);

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
  const errorCopy = error
    ? error.kind === 'inventory'
      ? {
          title: text('plugins.inspector.surface.inventoryUnavailable', 'Plugin inventory unavailable'),
          retry: text('plugins.inspector.surface.retryInventory', 'Try inventory again'),
        }
      : error.kind === 'navigation'
        ? {
            title: text('plugins.inspector.surface.navigationUnavailable', 'Inspector navigation unavailable'),
            retry: text('plugins.inspector.surface.retryNavigation', 'Try navigation again'),
          }
        : {
            title: text('plugins.inspector.surface.reloadUnavailable', 'Plugin reload failed'),
            retry: text('plugins.inspector.surface.retryReload', 'Try reload again'),
          }
    : null;
  const selfCheckStatus = readInspectorSelfCheckStatus(selfCheckSettlement, text);
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

  const quickMenus = (
    <Row gap="small" wrap align="center" style={{ flexDirection: rowDirection }}>
      <Menu
        testID="inspector-quick-actions-menu"
        open={quickActionsMenuOpen}
        onOpenChange={setQuickActionsMenuOpen}
        trigger={text('plugins.inspector.surface.quickMenu', 'Quick menu')}
        triggerTextVariant="caption"
        triggerTextTone="muted"
        triggerAccessibilityLabel={text(
          'plugins.inspector.surface.openQuickMenu',
          'Open Inspector quick menu',
        )}
        items={quickActionItems}
        onSelect={selectQuickAction}
      />
      <ContextMenu
        testID="inspector-quick-actions-context-menu"
        open={quickActionsContextMenuOpen}
        onOpenChange={setQuickActionsContextMenuOpen}
        trigger={text('plugins.inspector.surface.contextMenu', 'Context menu')}
        triggerTextVariant="caption"
        triggerTextTone="muted"
        triggerAccessibilityLabel={text(
          'plugins.inspector.surface.openContextMenu',
          'Open Inspector context menu',
        )}
        items={quickActionItems}
        onSelect={selectQuickAction}
      />
    </Row>
  );
  const selfCheckAction = (
    <Action.Execute
      testID="inspector-self-check-action"
      action={INSPECTOR_SELF_CHECK_ACTION_ID}
      variant="primary"
      title={text('plugins.inspector.surface.selfCheck', 'Run Inspector self-check')}
      accessibilityLabel={text(
        'plugins.inspector.surface.executeSelfCheck',
        'Execute Inspector self-check',
      )}
      onSettled={(settled) => {
        const result = settled.status === 'success' && settled.result && typeof settled.result === 'object'
          ? settled.result as { ok?: unknown }
          : null;
        setSelfCheckSettlement(result?.ok === true ? 'success' : 'failed');
      }}
    />
  );
  const selfCheckSettled = (
    <Status
      testID="inspector-self-check-settled"
      label={selfCheckStatus.label}
      tone={selfCheckStatus.tone}
    />
  );
  const locationLabel = subPath && subPath.length > 0
    ? subPath
    : text('plugins.inspector.surface.pageOverview', 'Overview');

  // On its full page the Inspector is a configuration-style page: the public
  // page header and titled sections draw the same anatomy as Happier's own
  // settings pages. The pane placements keep their compact heading stack.
  const pageAnatomyHeader = (
    <>
      <PageHeader
        testID="inspector-page-header"
        title="Plugin Inspector"
        titleKey="plugins.inspector.title"
        description="Inspect installed plugins, diagnostics, and reload state."
        descriptionKey="plugins.inspector.description"
        leading={<BrandMark size="medium" externallyLabelled />}
        meta={[
          { key: 'location', text: locationLabel, testID: 'inspector-location' },
          ...(plugins ? [{
            key: 'count',
            text: text('plugins.inspector.surface.pluginCount', '{count} plugins', { count: plugins.length }),
          }] : []),
        ]}
        actions={quickMenus}
      />
      <ItemGroup
        testID="inspector-self-check-card"
        title={text('plugins.inspector.surface.surfaceHealth', 'Surface health')}
        description={text('plugins.inspector.surface.selfCheckDescription', 'Verify the Inspector action bridge.')}
      >
        <Item
          title={text('plugins.inspector.surface.selfCheckRow', 'Action bridge')}
          accessory={(
            <Row gap="small" wrap align="center" style={{ flexDirection: rowDirection }}>
              {selfCheckSettled}
              {selfCheckAction}
            </Row>
          )}
          accessoryOutsidePressable
          accessoryWraps
        />
        {canOpenSurface ? (
          <Item
            testID="inspector-open-diagnostics"
            title={text('plugins.inspector.surface.openDiagnostics', 'Open diagnostics')}
            subtitle={text('plugins.inspector.surface.openDiagnosticsHint', 'Per-plugin diagnostic details on their own page.')}
            onPress={() => { void openLocation('diagnostics'); }}
          />
        ) : null}
      </ItemGroup>
      <ItemGroup
        testID="inspector-inventory-title"
        title={text('plugins.inspector.surface.inventory', 'Plugin inventory')}
        description={text(
          'plugins.inspector.surface.inventoryDescription',
          'Search admitted plugins, inspect diagnostics, and reload one development plugin at a time.',
        )}
        surface="none"
      />
    </>
  );

  const surfaceHeader = (
    <Stack gap="medium">
        {onPage ? pageAnatomyHeader : (
          <>
            <Row gap="medium" wrap align="center" justify="space-between" style={{ flexDirection: rowDirection }}>
              <Stack gap="small" style={{ flex: 1, minWidth: 0 }}>
                <Row gap="small" wrap align="center" style={{ flexDirection: rowDirection }}>
                  <BrandMark size="small" showName />
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
                </Row>
                <Heading
                  level={1}
                  valueKey="plugins.inspector.title"
                  fallback="Plugin Inspector"
                  testID="inspector-title"
                />
                <Text
                  valueKey="plugins.inspector.description"
                  fallback="Inspect installed plugins, diagnostics, and reload state."
                  tone="secondary"
                />
              </Stack>
              {quickMenus}
            </Row>

            <Card tone="muted" padding="medium" testID="inspector-self-check-card">
              <Stack gap="small">
                <Text
                  value={text('plugins.inspector.surface.surfaceHealth', 'Surface health')}
                  variant="label"
                />
                <Text
                  valueKey="plugins.inspector.surface.selfCheckDescription"
                  fallback="Verify the Inspector action bridge."
                  variant="caption"
                  tone="secondary"
                />
                <Row gap="small" wrap align="center" justify="space-between" style={{ flexDirection: rowDirection }}>
                  {selfCheckAction}
                  {selfCheckSettled}
                </Row>
              </Stack>
            </Card>

            {canOpenSurface ? (
              <Row gap="small" wrap align="center" style={{ flexDirection: rowDirection }}>
                <Button
                  testID="inspector-open-page"
                  title={text('plugins.inspector.surface.openPage', 'Open full page')}
                  variant="secondary"
                  onPress={() => { void openLocation(''); }}
                />
              </Row>
            ) : null}

            <Stack gap="xsmall">
              <Heading
                level={2}
                value={text('plugins.inspector.surface.inventory', 'Plugin inventory')}
                testID="inspector-inventory-title"
              />
              <Text
                value={text(
                  'plugins.inspector.surface.inventoryDescription',
                  'Search admitted plugins, inspect diagnostics, and reload one development plugin at a time.',
                )}
                variant="caption"
                tone="secondary"
              />
            </Stack>
          </>
        )}

        {lastReload ? (
          <Stack testID="inspector-last-reload" gap="small">
            <Status
              tone={lastReload.ok ? 'secondary' : 'danger'}
              label={lastReload.ok
                ? text('plugins.inspector.surface.reloadSucceeded', 'Last reload succeeded')
                : text('plugins.inspector.surface.reloadFailed', 'Last reload failed')}
            />
            {lastReload.registryStatus ? (
              <Text
                value={text(
                  'plugins.inspector.surface.registryStatus',
                  'Registry: {status}',
                  { status: lastReload.registryStatus },
                )}
                variant="caption"
                tone="secondary"
              />
            ) : null}
            {lastReload.changedPluginIds && lastReload.changedPluginIds.length > 0 ? (
              <Text
                value={text(
                  'plugins.inspector.surface.changedPlugins',
                  'Changed: {plugins}',
                  { plugins: lastReload.changedPluginIds.join(', ') },
                )}
              />
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
            title={errorCopy?.title ?? error.message}
            description={error.message}
            action={errorCopy ? (
              <Button
                testID="inspector-error-retry"
                title={errorCopy.retry}
                variant="secondary"
                onPress={retryError}
              />
            ) : undefined}
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
    </Stack>
  );

  const surfaceFooter = (
    <Card tone="muted" padding="medium" testID="inspector-component-gallery">
      <Stack gap="medium">
        <Stack gap="xsmall">
          <Text
            value={text('plugins.inspector.surface.componentGallery', 'Component gallery')}
            variant="label"
          />
          <Text
            value={text(
              'plugins.inspector.surface.componentGalleryDescription',
              'Reference controls for validating the public Plugin UI interaction families.',
            )}
            variant="caption"
            tone="secondary"
          />
        </Stack>
        <List accessibilityLabel={text('plugins.inspector.surface.quickActions', 'Inspector quick actions')}>
          <List.Section title={text('plugins.inspector.surface.inventoryActions', 'List and icon actions')}>
            <ItemGroup accessibilityLabel={text('plugins.inspector.surface.quickActions', 'Inspector quick actions')}>
              <Item
                title={text('plugins.inspector.surface.refreshListRow', 'Refresh with list row')}
                subtitle={text('plugins.inspector.surface.refreshHint', 'Reads the current admitted plugin list')}
                onPress={() => { void refreshPluginList(); }}
              />
              <IconButton
                accessibilityLabel={text('plugins.inspector.surface.refreshIcon', 'Refresh with icon button')}
                icon={<Icon name="refresh" />}
                busy={loading}
                onPress={() => refreshPluginList()}
              />
            </ItemGroup>
          </List.Section>
        </List>
        <ActionPanel title={text('plugins.inspector.surface.quickActions', 'Inspector quick actions')}>
          <ActionPanel.Section title={text('plugins.inspector.surface.inventoryActions', 'Data actions')}>
            <Action.Execute
              action="plugins.list"
              input={{}}
              title={text('plugins.inspector.surface.readWithAction', 'Read via Action.Execute')}
            />
            <Action.Copy
              value={JSON.stringify(plugins ?? [], null, 2)}
              title="Copy plugin inventory"
              titleKey="plugins.inspector.surface.copyInventory"
            />
          </ActionPanel.Section>
          <ActionPanel.Section title={text('plugins.inspector.surface.refreshActions', 'Refresh action')}>
            <Action.Refresh
              onRefresh={refreshPluginList}
              title={text('plugins.inspector.surface.refreshWithAction', 'Refresh via Action.Refresh')}
            />
          </ActionPanel.Section>
          <ActionPanel.Section title={text('plugins.inspector.surface.navigationActions', 'Inspector navigation')}>
            <Action.OpenExternal
              url="https://happier.dev/docs/plugins"
              title="Open plugin documentation"
              titleKey="plugins.inspector.surface.openDocumentation"
            />
            {canOpenSurface ? (
              <Action.OpenSurface
                view="inspector-page"
                input={{ source: 'inspector-action-panel' }}
                title="Open inspector page"
                titleKey="plugins.inspector.surface.openInspector"
              />
            ) : null}
          </ActionPanel.Section>
        </ActionPanel>
      </Stack>
    </Card>
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
