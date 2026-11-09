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
  Menu,
  PageHeader,
  Progress,
  Row,
  Stack,
  Status,
  Text,
  defineUiSurface,
  usePluginTheme,
  usePluginHostReadiness,
  usePluginTranslation,
  useSurfaceContext,
} from '@happier-dev/plugin-ui';
import { Collection, rankHappierQueryMatches, type CollectionRowActions, useHappierCollection } from '@happier-dev/plugin-ui/components';

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

type InspectorRequestError = Readonly<{
  message: string;
  code?: string;
  diagnostics?: readonly InspectorPluginDiagnostic[];
}>;

type InspectorSurfaceError = (
  | Readonly<{ kind: 'inventory' }>
  | Readonly<{ kind: 'navigation'; subPath: string }>
  | Readonly<{ kind: 'reload'; pluginId: string }>
) & InspectorRequestError;

function isPluginSummary(value: unknown): value is InspectorPluginSummary {
  return Boolean(value) && typeof value === 'object'
    && typeof (value as { pluginId?: unknown }).pluginId === 'string'
    && typeof (value as { enabled?: unknown }).enabled === 'boolean';
}

/**
 * Reads both diagnostic shapes the daemon returns: an Action failure's `{ code, message }`, and an
 * installed plugin's canonical diagnostic record, which keeps its code and words under `data` and
 * says whether it still applies. A resolved record is history, not a reason the row needs you.
 */
function readPluginDiagnostics(value: unknown): readonly InspectorPluginDiagnostic[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return [];
    const outer = entry as Readonly<Record<string, unknown>>;
    const resolution = outer.resolution && typeof outer.resolution === 'object'
      ? (outer.resolution as Readonly<Record<string, unknown>>).state
      : undefined;
    if (resolution === 'resolved') return [];
    const record = outer.data && typeof outer.data === 'object'
      ? outer.data as Readonly<Record<string, unknown>>
      : outer;
    const code = typeof record.code === 'string' ? record.code : undefined;
    const message = typeof record.message === 'string' ? record.message : undefined;
    return code === undefined && message === undefined ? [] : [{
      ...(code === undefined ? {} : { code }),
      ...(message === undefined ? {} : { message }),
    }];
  });
}

function readPluginsListResult(result: unknown):
  | Readonly<{ ok: true; plugins: readonly InspectorPluginSummary[] }>
  | Readonly<{ ok: false; code?: string; message?: string; diagnostics: readonly InspectorPluginDiagnostic[] }> {
  if (!result || typeof result !== 'object') {
    return { ok: true, plugins: [] };
  }
  const record = result as Readonly<Record<string, unknown>>;
  if (record.ok === false) {
    const diagnostics = readPluginDiagnostics(record.diagnostics);
    const code = diagnostics[0]?.code;
    const message = diagnostics[0]?.message;
    return {
      ok: false,
      diagnostics,
      ...(code === undefined ? {} : { code }),
      ...(message === undefined ? {} : { message }),
    };
  }
  return { ok: true, plugins: Array.isArray(record.plugins) ? record.plugins.filter(isPluginSummary) : [] };
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

function readErrorMessage(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'message' in error && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return undefined;
}

function readRequestError(error: unknown, fallbackMessage: string): InspectorRequestError {
  const record = error && typeof error === 'object' ? error as Readonly<Record<string, unknown>> : null;
  const code = typeof record?.code === 'string' ? record.code : undefined;
  const diagnostics = readPluginDiagnostics(record?.diagnostics);
  const message = diagnostics.find((entry) => entry.message && entry.message !== entry.code)?.message
    ?? readErrorMessage(error);
  return {
    message: message && message !== code ? message : fallbackMessage,
    ...(code === undefined ? {} : { code }),
    ...(diagnostics.length === 0 ? {} : { diagnostics }),
  };
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

function inspectorPluginByline(plugin: InspectorPluginSummary): string {
  return `${plugin.pluginId}${plugin.version ? ` · v${plugin.version}` : ''} · ${inspectorPluginStatus(plugin)}`;
}

function inspectorPluginSearchText(plugin: InspectorPluginSummary) {
  return {
    label: inspectorPluginLabel(plugin),
    subtitle: inspectorPluginByline(plugin),
    exactSearchText: plugin.pluginId,
  };
}

const NO_PLUGINS: readonly InspectorPluginSummary[] = [];
const noOpenRow = () => {};

export function InspectorSurface({ hostApi, surface, subPath }: InspectorRenderSurfaceContext): React.ReactElement {
  const [plugins, setPlugins] = React.useState<readonly InspectorPluginSummary[] | null>(null);
  const [search, setSearch] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const inventoryRead = React.useRef<Promise<void> | null>(null);
  const [error, setError] = React.useState<InspectorSurfaceError | null>(null);
  const [reloadingPluginId, setReloadingPluginId] = React.useState<string | null>(null);
  const [lastReload, setLastReload] = React.useState<InspectorReloadSummary | null>(null);
  const [quickActionsMenuOpen, setQuickActionsMenuOpen] = React.useState(false);
  const [selfCheckSettlement, setSelfCheckSettlement] = React.useState<InspectorSelfCheckSettlement>('not-run');
  const [quickActionsContextMenuOpen, setQuickActionsContextMenuOpen] = React.useState(false);
  const surfaceContext = useSurfaceContext();
  const readiness = usePluginHostReadiness();
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
      setError({ kind: 'navigation', ...readRequestError(requestError,
        text('plugins.inspector.surface.navigationUnavailable', 'Inspector navigation unavailable')), subPath: nextSubPath });
    }
  }, [canOpenSurface, hostApi, text]);

  const refreshPluginList = React.useCallback((afterReload = false): Promise<void> => {
    // Pending or unready prerequisites defer the read; admission (a readiness revision) starts it.
    // Settled refusals use the Action's existing error contract.
    if (readiness.pending || readiness.ready === false) return Promise.resolve();
    if (inventoryRead.current && !afterReload) return inventoryRead.current;
    if (!hostApi) {
      setError({ kind: 'inventory', code: 'host_api_unavailable',
        message: text('plugins.inspector.surface.inventoryUnavailable', 'Plugin inventory unavailable') });
      return Promise.resolve();
    }
    setLoading(true);
    setError(null);
    // Ordinary entrances share one read; reload completion requires a new one.
    // Only that current read may publish inventory, errors or loading state.
    const read = Promise.resolve().then(async () => {
      try {
        // The list shows identity, state and diagnostics only, so it asks for the summary projection.
        const result = await hostApi.executeAction('plugins.list', { projection: 'summary' });
        if (inventoryRead.current !== read) return;
        const inventory = readPluginsListResult(result);
        if (inventory.ok) {
          setPlugins(inventory.plugins);
        } else {
          setError({ kind: 'inventory', ...readRequestError(inventory,
            text('plugins.inspector.surface.inventoryUnavailable', 'Plugin inventory unavailable')) });
        }
      } catch (requestError) {
        if (inventoryRead.current !== read) return;
        setError({ kind: 'inventory', ...readRequestError(requestError,
          text('plugins.inspector.surface.inventoryUnavailable', 'Plugin inventory unavailable')) });
      } finally {
        if (inventoryRead.current === read) {
          inventoryRead.current = null;
          setLoading(false);
        }
      }
    });
    inventoryRead.current = read;
    return read;
  }, [hostApi, readiness.pending, readiness.ready, text]);

  React.useEffect(() => {
    void refreshPluginList();
    return () => { inventoryRead.current = null; };
  }, [refreshPluginList, readiness.revision]);

  const reloadPlugin = React.useCallback(async (pluginId: string) => {
    if (!hostApi) {
      setError({ kind: 'reload', code: 'host_api_unavailable', pluginId,
        message: text('plugins.inspector.surface.reloadUnavailable', 'Plugin reload failed') });
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
      await refreshPluginList(true);
    } catch (requestError) {
      setError({ kind: 'reload', ...readRequestError(requestError,
        text('plugins.inspector.surface.reloadUnavailable', 'Plugin reload failed')), pluginId });
    } finally {
      setReloadingPluginId(null);
    }
  }, [hostApi, refreshPluginList, text]);

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
  // Each row reloads its own plugin: one tap, one development plugin at a time.
  const useInspectorRowActions = React.useCallback((plugin: InspectorPluginSummary): CollectionRowActions => {
    const label = inspectorPluginLabel(plugin);
    const reloading = reloadingPluginId === plugin.pluginId;
    return {
      busy: reloading,
      accessory: (
        <Button
          testID={`inspector-reload-${plugin.pluginId}`}
          variant="secondary"
          // One per row: the small step keeps a column of them quieter than the rows they serve.
          size="small"
          disabled={reloadingPluginId !== null}
          title={reloading
            ? text('plugins.inspector.surface.reloading', 'Reloading…')
            : text('plugins.inspector.surface.reload', 'Reload')}
          accessibilityLabel={`${text('plugins.inspector.surface.reload', 'Reload')} ${label}`}
          onPress={() => { void reloadPlugin(plugin.pluginId); }}
        />
      ),
    };
  }, [reloadPlugin, reloadingPluginId, text]);
  const visiblePlugins = React.useMemo(
    () => rankHappierQueryMatches(plugins ?? NO_PLUGINS, search, inspectorPluginSearchText),
    [plugins, search],
  );
  const collection = useHappierCollection({
    items: visiblePlugins,
    keyOf: keyForInspectorPlugin,
    selection: 'none',
    openKey: null,
    onOpenChange: noOpenRow,
  });

  // The page header's secondary actions: one quiet ⋯ menu beside the Run-on chip, never loose text links.
  const quickMenus = (
    <Menu
      testID="inspector-quick-actions-menu"
      open={quickActionsMenuOpen}
      onOpenChange={setQuickActionsMenuOpen}
      trigger={text('plugins.inspector.surface.quickMenu', 'Quick menu')}
      triggerIcon="more"
      triggerAccessibilityLabel={text(
        'plugins.inspector.surface.openQuickMenu',
        'Open Inspector quick menu',
      )}
      items={quickActionItems}
      onSelect={selectQuickAction}
    />
  );
  // The context menu is a gallery specimen of the ContextMenu family, so it lives in the gallery.
  const contextMenuSpecimen = (
    <ContextMenu
      testID="inspector-quick-actions-context-menu"
      open={quickActionsContextMenuOpen}
      onOpenChange={setQuickActionsContextMenuOpen}
      trigger={text('plugins.inspector.surface.contextMenu', 'Context menu')}
      triggerAppearance="control"
      triggerAccessibilityLabel={text(
        'plugins.inspector.surface.openContextMenu',
        'Open Inspector context menu',
      )}
      items={quickActionItems}
      onSelect={selectQuickAction}
    />
  );
  const selfCheckAction = (
    <Action.Execute
      testID="inspector-self-check-action"
      action={INSPECTOR_SELF_CHECK_ACTION_ID}
      // A diagnostic the user runs rarely: a quiet control, never the view's one filled button.
      variant="secondary"
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
  // Only a sub-page names its location; at the root it would repeat what the title already says.
  const locationLabel = subPath && subPath.length > 0 ? subPath : null;

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
        // The header is the same height while the inventory loads and once it has: the plugin count
        // lives beside the inventory it counts, not on a line that appears after the title.
        meta={locationLabel ? [{ key: 'location', text: locationLabel, testID: 'inspector-location' }] : undefined}
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
        action={(
          // Held (a blank line) until the inventory answers, so the count arrives without moving the section.
          <Text
            testID="inspector-plugin-count"
            value={plugins ? text('plugins.inspector.surface.pluginCount', '{count} plugins', { count: plugins.length }) : '\u00A0'}
            tone="secondary"
          />
        )}
        surface="none"
      />
    </>
  );

  const surfaceHeader = (
    <Stack gap="medium">
        {onPage ? pageAnatomyHeader : (
          <>
            {/*
              * A pane placement sits under the host's pane header, which already names the
              * Inspector; repeating its mark, name and a large title here said it three times.
              * The pane opens on what it is for, with the quick actions beside it.
              */}
            <Row gap="medium" align="center" justify="space-between" style={{ flexDirection: rowDirection }}>
              <Row gap="small" align="center" style={{ flex: 1, minWidth: 0, flexDirection: rowDirection }}>
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
                <Stack style={{ flex: 1, minWidth: 0 }}>
                  <Text
                    testID="inspector-pane-description"
                    valueKey="plugins.inspector.description"
                    fallback="Inspect installed plugins, diagnostics, and reload state."
                    tone="secondary"
                  />
                </Stack>
              </Row>
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
                  variant="micro"
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
                variant="micro"
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
                variant="micro"
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

        {error && !(error.kind === 'inventory' && readiness.pending) ? (
          // In the page column with the sections around it (an untitled page section), not across the pane.
          <ItemGroup surface="none">
            <Banner
              testID="inspector-error"
              tone="danger"
              title={errorCopy?.title ?? error.message}
              // The cause only when it adds something: a message that restates the headline is dropped.
              description={errorCopy && error.message.trim() !== errorCopy.title ? error.message : undefined}
              action={errorCopy ? (
                <Button
                  testID="inspector-error-retry"
                  title={errorCopy.retry}
                  variant="secondary"
                  onPress={retryError}
                />
              ) : undefined}
            />
          </ItemGroup>
        ) : null}
        {loading && plugins ? (
          <Progress
            testID="inspector-refresh-progress"
            label={text('plugins.inspector.surface.refreshing', 'Refreshing plugin inventory')}
          />
        ) : null}
    </Stack>
  );

  // On the page the gallery is the last page section, in the page column like every section above it.
  // The pane keeps its compact muted card.
  const galleryTitle = text('plugins.inspector.surface.componentGallery', 'Component gallery');
  const galleryDescription = text(
    'plugins.inspector.surface.componentGalleryDescription',
    'Reference controls for validating the public Plugin UI interaction families.',
  );
  const gallerySpecimens = (
      <Stack gap="medium">
        <Row gap="small" wrap align="center">{contextMenuSpecimen}</Row>
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
              disabled={readiness.pending || readiness.ready === false}
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
  );
  const surfaceFooter = onPage ? (
    <ItemGroup testID="inspector-component-gallery" title={galleryTitle} description={galleryDescription} surface="none">
      {gallerySpecimens}
    </ItemGroup>
  ) : (
    <Card tone="muted" padding="medium" testID="inspector-component-gallery">
      <Stack gap="medium">
        <Stack gap="xsmall">
          <Text value={galleryTitle} variant="label" />
          <Text value={galleryDescription} variant="micro" tone="secondary" />
        </Stack>
        {gallerySpecimens}
      </Stack>
    </Card>
  );

  // One scrolling page (or pane): the header, the inventory rows and the gallery move together, so the
  // rows get the room instead of sitting between fixed header and footer chrome.
  return (
    <Collection<InspectorPluginSummary>
      testID="inspector-surface"
      model={collection}
      presentation="list"
      detail="none"
      scroll="page"
      minListWidth={280}
      minDetailWidth={0}
      preferredListRatio={1}
      accessibilityLabel={text('plugins.inspector.surface.inventory', 'Installed plugins')}
      loading={plugins === null && (loading || !error || readiness.pending)}
      anatomy={{
        glyph: () => null,
        title: inspectorPluginLabel,
        byline: inspectorPluginByline,
        reason: (plugin) => {
          const diagnostics = readPluginDiagnostics(plugin.diagnostics);
          return diagnostics.length === 0 ? null : (
            <Text
              testID={`inspector-diagnostics-${plugin.pluginId}`}
              value={diagnostics.flatMap((diagnostic) => diagnostic.message ?? diagnostic.code ?? []).join(' · ')}
              tone="danger"
            />
          );
        },
        accessibilityLabel: inspectorPluginLabel,
        testID: (plugin) => `inspector-plugin-${plugin.pluginId}`,
        columnTitles: { title: text('plugins.inspector.surface.inventory', 'Installed plugins') },
      }}
      useRowActions={useInspectorRowActions}
      {...(plugins && plugins.length > 0 ? { search: {
        testID: 'inspector-plugin-search',
        label: text('plugins.inspector.surface.search', 'Search installed plugins'),
        placeholder: text('plugins.inspector.surface.searchPlaceholder', 'Search by name or plugin ID'),
        value: search,
        onValueChange: setSearch,
      } } : {})}
      // On the page the page header owns the page edge, top included (as the rows below it do), so the loaded
      // header sits exactly where the host's loading header stood; the pane pads its stack.
      header={<Stack style={onPage ? undefined : { paddingHorizontal: theme.spacing.medium, paddingTop: theme.spacing.medium }}>{surfaceHeader}</Stack>}
      empty={plugins === null ? null : plugins.length === 0 ? (
        <EmptyState title={text('plugins.inspector.surface.empty', 'No plugins installed.')} />
      ) : (
        <EmptyState
          testID="inspector-plugin-search-empty"
          title={text('plugins.inspector.surface.noMatches', 'No matching plugins')}
          description={text('plugins.inspector.surface.noMatchesDescription', 'Try a different name or plugin ID.')}
        />
      )}
      footer={onPage ? surfaceFooter : <Stack style={{ padding: theme.spacing.medium }}>{surfaceFooter}</Stack>}
    />
  );
}

export const renderSurface = defineUiSurface(InspectorSurface);
