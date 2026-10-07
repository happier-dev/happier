import * as React from 'react';
import type { RenderContext, RenderSurface } from '@happier-dev/plugin-sdk/ui';
import {
  BrandMark,
  EmptyState,
  Icon,
  IconButton,
  Item,
  ItemGroup,
  LoadingState,
  NavigationList,
  defineUiSurface,
  usePluginBrandDisplayNameResolver,
  usePluginHostApi,
  usePluginTranslation,
} from '@happier-dev/plugin-ui';

import {
  CHANNELS_PAGE_VIEW_ID,
  CHANNELS_SETTINGS_PAGE_ID,
} from '../../sessionSurfaceIds.js';
import {
  buildChannelsConversationIndex,
  connectionLabel,
  connectionStatus,
  readChannelsPageLocation,
  useAccountConversationSnapshot,
  useDaemonConversationSnapshot,
  type ChannelsConversationIndexGroup,
  type ChannelsConversationIndexRow,
  type ChannelsConversationSnapshot,
  type Translate,
} from '../conversationRows.js';

/**
 * The Channels column and the Channels Home widget: the two small surfaces
 * that glance at the Account's linked conversations and send the reader to the
 * Channels page (lab `channels` C1 column, W1 widget).
 *
 * They share one artifact because they read the same rows and only navigate:
 * neither edits anything, so the page stays the one writer. The host mounts the
 * column beside the page (the page's own destination) and the widget on Home
 * (an embedded `widget` mount), which is how one render function tells them
 * apart.
 */

/** The column offers search only once scanning by eye gets slow (lab C1). */
export const CHANNELS_COLUMN_SEARCH_THRESHOLD = 8;
/** Home is a glance, not the list: the page holds the rest. */
export const CHANNELS_WIDGET_ROWS = 4;

function useProviderName(t: Translate): (providerPluginId: string) => string {
  const resolve = usePluginBrandDisplayNameResolver();
  return React.useCallback(
    (providerPluginId: string) => resolve(providerPluginId)
      ?? t('plugins.channels.surface.providerFallback', 'Integration provider'),
    [resolve, t],
  );
}

function useOpenChannels(): Readonly<{
  openConversation: (bindingId: string) => void;
  openPage: (subPath: string) => void;
  openSettings: () => void;
}> {
  const hostApi = usePluginHostApi();
  return React.useMemo(() => ({
    openConversation: (bindingId: string) => {
      void hostApi.openSurface(CHANNELS_PAGE_VIEW_ID, undefined, { subPath: bindingId }).catch(() => undefined);
    },
    openPage: (subPath: string) => {
      void hostApi.openSurface(CHANNELS_PAGE_VIEW_ID, undefined, { subPath }).catch(() => undefined);
    },
    openSettings: () => {
      void hostApi.openSurface(CHANNELS_SETTINGS_PAGE_ID).catch(() => undefined);
    },
  }), [hostApi]);
}

function groupTitle(group: ChannelsConversationIndexGroup, providerName: (id: string) => string, t: Translate): string {
  if (group.connection !== undefined) return connectionLabel(group.connection);
  if (group.providerPluginId !== undefined) return providerName(group.providerPluginId);
  return t('plugins.channels.column.otherGroup', 'Other conversations');
}

function rowStatusLabel(row: ChannelsConversationIndexRow, t: Translate): string | undefined {
  if (row.status?.kind === 'paused') return t('plugins.channels.column.paused', 'Paused');
  if (row.status?.kind === 'deleting') return t('plugins.channels.surface.deleteFinalizing', 'Deletion cleanup in progress');
  return undefined;
}

function ChannelsColumn(props: Readonly<{
  snapshot: ChannelsConversationSnapshot;
  subPath: string | undefined;
}>): React.ReactElement {
  const t = usePluginTranslation();
  const providerName = useProviderName(t);
  const navigation = useOpenChannels();
  const [query, setQuery] = React.useState('');
  const { bindings, connections } = props.snapshot;
  const groups = React.useMemo(
    () => buildChannelsConversationIndex({ bindings, connections, providerName, t }),
    [bindings, connections, providerName, t],
  );
  const selectedBindingId = readChannelsPageLocation(props.subPath).bindingId;
  const searchable = bindings.length > CHANNELS_COLUMN_SEARCH_THRESHOLD;
  const needle = searchable ? query.trim().toLocaleLowerCase() : '';
  const visibleGroups = React.useMemo(() => (needle === ''
    ? groups
    : groups
      .map((group) => ({ ...group, rows: group.rows.filter((row) => row.title.toLocaleLowerCase().includes(needle)) }))
      .filter((group) => group.rows.length > 0)), [groups, needle]);
  const hasBots = connections.some((connection) => connection.deletionState === 'none');

  return (
    <NavigationList
      testID="channels-column"
      titleKey="plugins.channels.page.title"
      title="Channels"
      headerAction={hasBots ? (
        <IconButton
          testID="channels-column-link"
          accessibilityLabel={t('plugins.channels.column.link', 'Link a conversation')}
          icon={<Icon name="add" size="small" tone="secondary" />}
          onPress={() => navigation.openPage('link')}
        />
      ) : undefined}
      search={searchable ? {
        value: query,
        onValueChange: setQuery,
        label: t('plugins.channels.column.search', 'Search conversations'),
        testID: 'channels-column-search',
      } : null}
      footer={{
        title: t('plugins.channels.column.botsAndConnections', 'Bots & connections'),
        icon: 'settings',
        onPress: navigation.openSettings,
        testID: 'channels-column-bots',
      }}
    >
      {props.snapshot.state === 'ready' && bindings.length === 0 ? (
        <EmptyState
          testID="channels-column-empty"
          layout="line"
          title={t('plugins.channels.column.empty', 'No conversations yet.')}
        />
      ) : null}
      {props.snapshot.state === 'error' && bindings.length === 0 ? (
        <EmptyState
          testID="channels-column-error"
          layout="line"
          title={t('plugins.channels.column.unavailable', 'Conversations can’t be read right now.')}
        />
      ) : null}
      {needle !== '' && visibleGroups.length === 0 ? (
        <EmptyState
          testID="channels-column-no-results"
          layout="line"
          title={t('plugins.channels.column.noResults', 'No conversation matches “{query}”.', { query: query.trim() })}
        />
      ) : null}
      {visibleGroups.map((group, index) => (
        <NavigationList.Group
          key={group.key}
          first={index === 0}
          title={groupTitle(group, providerName, t)}
          {...(group.providerPluginId === undefined ? {} : {
            mark: <BrandMark pluginId={group.providerPluginId} size="small" externallyLabelled />,
          })}
          {...(group.botAttention === undefined ? {} : {
            status: { kind: 'attention' as const, label: t('plugins.channels.column.botNeedsYou', 'Bot needs you') },
          })}
        >
          {group.rows.map((row) => {
            const statusLabel = rowStatusLabel(row, t);
            return (
              <NavigationList.Row
                key={row.binding.bindingId}
                testID={`channels-column-row-${row.binding.bindingId}`}
                title={row.title}
                selected={row.binding.bindingId === selectedBindingId}
                {...(statusLabel === undefined ? {} : {
                  status: { kind: row.status?.kind === 'paused' ? 'paused' as const : 'attention' as const, label: statusLabel },
                })}
                onPress={() => navigation.openConversation(row.binding.bindingId)}
              />
            );
          })}
        </NavigationList.Group>
      ))}
    </NavigationList>
  );
}

type WidgetRow = Readonly<{
  key: string;
  bindingId: string;
  title: string;
  subtitle: string;
  attention: boolean;
}>;

/**
 * Home's rows (lab W1): a bot that needs you first — one row per cause, naming
 * the conversations it affects — then conversations paused for review, then
 * the rest by name, four rows in all.
 */
function buildWidgetRows(
  groups: readonly ChannelsConversationIndexGroup[],
  providerName: (id: string) => string,
  t: Translate,
): readonly WidgetRow[] {
  const causes: WidgetRow[] = [];
  const paused: WidgetRow[] = [];
  const rest: WidgetRow[] = [];
  for (const group of groups) {
    const firstRow = group.rows[0];
    if (group.botAttention !== undefined && firstRow !== undefined && firstRow.connection !== undefined) {
      causes.push({
        key: `cause:${group.key}`,
        bindingId: firstRow.binding.bindingId,
        title: group.rows.map((row) => row.title).join(' · '),
        subtitle: connectionStatus(firstRow.connection, t).label,
        attention: true,
      });
    }
    for (const row of group.rows) {
      if (group.botAttention !== undefined) continue;
      const provider = row.connection === undefined
        ? t('plugins.channels.surface.providerFallback', 'Integration provider')
        : providerName(row.connection.providerPluginId);
      if (row.status?.kind === 'paused') {
        paused.push({
          key: row.binding.bindingId,
          bindingId: row.binding.bindingId,
          title: row.title,
          subtitle: t('plugins.channels.widget.paused', 'Paused · {provider}', { provider }),
          attention: false,
        });
      } else if (row.status === undefined) {
        rest.push({
          key: row.binding.bindingId,
          bindingId: row.binding.bindingId,
          title: row.title,
          subtitle: provider,
          attention: false,
        });
      }
    }
  }
  return [...causes, ...paused, ...rest].slice(0, CHANNELS_WIDGET_ROWS);
}

function ChannelsHomeWidget(props: Readonly<{ snapshot: ChannelsConversationSnapshot }>): React.ReactElement {
  const t = usePluginTranslation();
  const providerName = useProviderName(t);
  const navigation = useOpenChannels();
  const { bindings, connections } = props.snapshot;
  const rows = React.useMemo(
    () => buildWidgetRows(buildChannelsConversationIndex({ bindings, connections, providerName, t }), providerName, t),
    [bindings, connections, providerName, t],
  );

  if (props.snapshot.state === 'loading' && bindings.length === 0) {
    return (
      <LoadingState
        testID="channels-widget-loading"
        title={t('plugins.channels.widget.loading', 'Loading conversations')}
        rows={3}
      />
    );
  }
  if (bindings.length === 0) {
    const noBots = !connections.some((connection) => connection.deletionState === 'none');
    return (
      <EmptyState
        testID="channels-widget-empty"
        layout="line"
        title={props.snapshot.state === 'error'
          ? t('plugins.channels.column.unavailable', 'Conversations can’t be read right now.')
          : noBots
            ? t('plugins.channels.widget.noBots', 'Connect a bot to talk to your sessions from Telegram, Discord or GitHub.')
            : t('plugins.channels.widget.noConversations', 'Link a conversation to a session.')}
      />
    );
  }
  return (
    <ItemGroup testID="channels-widget-rows">
      {rows.map((row) => (
        <Item
          key={row.key}
          testID={`channels-widget-row-${row.key}`}
          title={row.title}
          titleNumberOfLines={1}
          subtitle={row.subtitle}
          subtitleNumberOfLines={1}
          {...(row.attention ? { icon: <Icon name="warning" size="small" tone="attention" />, tone: 'attention' as const } : {})}
          density="compact"
          onPress={() => navigation.openConversation(row.bindingId)}
        />
      ))}
    </ItemGroup>
  );
}

type GlanceView = Readonly<{ kind: 'column'; subPath: string | undefined } | { kind: 'widget' }>;

function GlanceBody(props: Readonly<{ view: GlanceView; snapshot: ChannelsConversationSnapshot }>): React.ReactElement {
  return props.view.kind === 'widget'
    ? <ChannelsHomeWidget snapshot={props.snapshot} />
    : <ChannelsColumn snapshot={props.snapshot} subPath={props.view.subPath} />;
}

function AccountGlance(props: Readonly<{ view: GlanceView; signal: AbortSignal }>): React.ReactElement {
  const snapshot = useAccountConversationSnapshot(props.signal);
  return <GlanceBody view={props.view} snapshot={snapshot} />;
}

/**
 * A daemon outage demotes the mount to the direct Account read, exactly as the
 * Settings and Channels pages do; the live Resources stay subscribed so the
 * store's own watch retry brings the daemon read back.
 */
function DaemonGlance(props: Readonly<{ view: GlanceView; signal: AbortSignal }>): React.ReactElement {
  const { snapshot, unavailable } = useDaemonConversationSnapshot();
  return unavailable
    ? <AccountGlance view={props.view} signal={props.signal} />
    : <GlanceBody view={props.view} snapshot={snapshot} />;
}

export function ChannelsGlanceSurface(context: RenderContext): React.ReactElement {
  const view: GlanceView = context.surface.mount.kind === 'embedded'
    ? { kind: 'widget' }
    : { kind: 'column', subPath: context.subPath };
  return context.hostApi.version().methods.includes('readResource')
    ? <DaemonGlance view={view} signal={context.signal} />
    : <AccountGlance view={view} signal={context.signal} />;
}

export const renderSurface: RenderSurface = defineUiSurface(ChannelsGlanceSurface);
