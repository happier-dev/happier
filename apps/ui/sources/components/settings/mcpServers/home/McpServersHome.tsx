import * as React from 'react';
import { formatHappierCapabilityCount as formatCapabilityCount } from '@happier-dev/plugin-ui/presentation';
import { Image, View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { HomeOrbitMap } from '@/components/atmosphere/orbit/HomeOrbitMap';
import { layoutHomeOrbitRing } from '@/components/atmosphere/orbit/homeOrbitScene';
import { CapabilityRow } from '@/components/capabilities/row/CapabilityRow';
import { CapabilityStatusChip } from '@/components/capabilities/status/CapabilityStatusChip';
import { presentCapabilityStatus } from '@/components/capabilities/status/capabilityStatusPresentation';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton, RoundButtonSizeScope } from '@/components/ui/buttons/RoundButton';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { collectionListStyles } from '@/components/ui/lists/collection/CollectionList';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { PageContentColumn } from '@/components/ui/lists/PageContentColumn';
import { resolveItemGroupContentHorizontalInsetPx } from '@/components/ui/lists/itemGroupSpacing';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { joinList } from '@/utils/text/joinList';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
  mcpServerRoute,
} from '../collection/mcpServerCollectionModel';
import { McpServerMark } from '../identity/McpServerMark';
import { HappierBrandMark } from '@/components/ui/media/HappierBrandMark';
import {
  MCP_RING_MORE_KEY,
  type McpHome,
  type McpHomeServer,
} from './mcpHomeModel';
import { McpFoundBlock } from './McpFoundBlock';
import { McpRegistryShelf } from './McpRegistryShelf';
import { setPreviewedMcpServer, usePreviewedMcpServer } from './mcpServerPreview';
import { useMcpHome } from './useMcpHome';
import { useMcpAddPlaces } from '../add/useMcpAddPlaces';
import { useOpenMcpAddModal } from '../add/useOpenMcpAddModal';
import { shortWhereItsOn, type WhereItsOnNames } from '@/components/capabilities/where/whereItsOnPresentation';

/** The tether map beside its legend (lab hm-A §12: ring radius 104 around a 36 px planet; the box is the ring and its marks, so the legend keeps the room). */
const MAP_BOX = {
  width: 220,
  height: 268,
  planetRadius: 36,
  ring: 104,
} as const;
/** Phone hero: the map alone across the column, a little smaller (lab hm-A2p). */
const PHONE_MAP = { height: 244, planetRadius: 32, ring: 92 } as const;
const RING_MARK_PX = 22;
/** The legend's narrowest useful column (lab hm-A2 holds map and legend side by side at 1440); under it the legend moves beneath the map. */
const LEGEND_MIN_PX = 320;
const REACH_GAP_PX = 16;
const SIDE_BY_SIDE_MIN_PX = MAP_BOX.width + REACH_GAP_PX + LEGEND_MIN_PX;

function useGo() {
  const router = useRouter();
  return React.useCallback(
    (href: string) => {
      const result = runGuardedNavigation(() => router.push(href as never));
      if (result !== true) fireAndForget(result, { tag: 'McpServersHome.go' });
    },
    [router],
  );
}

/**
 * `/settings/mcp` beside the rail: the homepage (P7 U7.11, lab hm-A Reach). The Home planet with every
 * server's mark on a ring, tethered by how it reaches the agents; the legend says the same in words in
 * two groups, each problem with its one fix; then the present in one line, the registry's suggestions
 * and what is already on the machines.
 */
export const McpServersHome = React.memo(function McpServersHome() {
  const home = useMcpHome();
  return <McpServersHomeView home={home} />;
});

/** The homepage drawn from its data (the dev specimen renders it from lab-cast fixtures). */
export const McpServersHomeView = React.memo(function McpServersHomeView(
  props: Readonly<{ home: McpHomeData }>,
) {
  return (
    <ItemList pageColumn="wide">
      <PageContentColumn>
        <McpServersHomeBody home={props.home} />
      </PageContentColumn>
    </ItemList>
  );
});

export type McpHomeData = ReturnType<typeof useMcpHome>;

const McpServersHomeBody = React.memo(function McpServersHomeBody(
  props: Readonly<{ home: McpHomeData }>,
) {
  const { home } = props;
  const go = useGo();
  const openAdd = useOpenMcpAddModal();
  const { model } = home;
  const brandNew =
    !home.loading && !home.unavailable && model.servers.length === 0;
  const firstVisit = model.firstVisitLine && !brandNew;
  const headline = brandNew
    ? t('capabilities.mcpHome.newTitle')
    : firstVisit
      ? t('capabilities.mcpHome.firstHeadline')
      : t('settings.mcpServers');
  const purpose = brandNew
    ? t('capabilities.mcpHome.newBody')
    : firstVisit
      ? t('capabilities.mcpHome.firstPurpose')
      : t('capabilities.mcpHome.purpose');
  return (
    <>
      <PageHeader
        testID="mcp.home.header"
        title={headline}
        alwaysShowTitle
        description={purpose}
        {...(firstVisit
          ? {
              actionsPlacement: 'page' as const,
              actions: (
                <IconButton
                  testID="mcp.home.firstVisit.dismiss"
                  iconName="x"
                  variant="plain"
                  accessibilityLabel={t('capabilities.mcpHome.firstDismiss')}
                  tooltip={t('capabilities.mcpHome.firstDismiss')}
                  onPress={home.dismissFirstVisit}
                />
              ),
            }
          : {})}
      />
      {/* What needs the person leads; the map says how the rest reaches the agents. */}
      {home.loading || home.unavailable ? null : (
        <NeedsYou attention={model.attention} onOpen={(serverId) => go(mcpServerRoute(serverId))} />
      )}
      <View style={styles.inset}>
        {home.unavailable ? (
          <SurfaceStateCard
            testID="mcp.home.error"
            size="page"
            kind="error"
            title={t('capabilities.mcpHome.loadFailed')}
            action={{
              label: t('common.retry'),
              onPress: () => {
                void home.reload();
              },
            }}
          />
        ) : (
          <ReachBlock
            home={model}
            phone={false}
            loading={home.loading}
            brandNew={brandNew}
            suggestions={home.suggestions}
          />
        )}
        {home.loading || home.unavailable || brandNew ? null : (
          <PresentLine home={model} />
        )}
        {brandNew ? (
          <RoundButtonSizeScope size="normal" presentation="uniform">
            <View style={styles.acts}>
            <RoundButton
              testID="mcp.home.browse"
              title={t('capabilities.mcpHome.browse')}
              onPress={() => openAdd({ modeKey: 'catalog' })}
            />
            <RoundButton
              testID="mcp.home.paste"
              display="secondary"
              title={t('capabilities.mcpHome.paste')}
              onPress={() => openAdd({ modeKey: 'paste' })}
            />
          </View>
          </RoundButtonSizeScope>
        ) : null}
      </View>
      {home.loading || home.unavailable ? null : (
        <McpRegistryShelf
          shelf={home.shelf}
          servers={model.servers}
          onAdd={(card) =>
            openAdd({ modeKey: 'catalog', sourceId: card.sourceId, query: card.title })
          }
          onOpen={(serverId) => go(mcpServerRoute(serverId))}
        />
      )}
      {home.loading || home.unavailable ? null : (
        <McpFoundBlock presentation="section" />
      )}
    </>
  );
});

/**
 * A phone's root (lab np:home): the homepage's map with its legend beneath, its one line of the present and
 * Needs you with each fix, above the server list.
 */
export const McpServersHomeSummary = React.memo(function McpServersHomeSummary() {
  const home = useMcpHome();
  const go = useGo();
  if (home.unavailable) return null;
  return (
    <>
      <View testID="mcp.home.summary" style={styles.inset}>
        <ReachBlock
          home={home.model}
          loading={home.loading}
          brandNew={false}
          phone
          suggestions={home.suggestions}
        />
        {home.loading ? null : <PresentLine home={home.model} />}
      </View>
      {home.loading || home.model.attention.length === 0 ? null : (
        // The section ends at the page rhythm before the list's view switch (lab np:home).
        <View style={styles.summaryEnd}>
          <NeedsYou attention={home.model.attention} onOpen={(serverId) => go(mcpServerRoute(serverId))} />
        </View>
      )}
    </>
  );
});

/**
 * No servers where no homepage stands beside a rail (a phone's list page, a narrow pane): the page-level
 * empty state with its built-in scene (lab mp-E), then what is already on the machines and the registry's
 * suggestions, so the first add is one press away.
 */
export const McpServersEmpty = React.memo(function McpServersEmpty() {
  const home = useMcpHome();
  const go = useGo();
  const openAdd = useOpenMcpAddModal();
  if (home.loading) return null;
  if (home.unavailable) {
    return (
      <SurfaceStateCard
        testID="settings.mcpServers.loadFailed"
        size="page"
        kind="error"
        title={t('capabilities.mcpHome.loadFailed')}
        action={{ label: t('common.retry'), onPress: () => { void home.reload(); } }}
      />
    );
  }
  return (
    <>
      <EmptyState
        testID="settings.mcpServers.invitation"
        layout="page"
        scene="nothingListening"
        title={t('capabilities.mcpHome.newTitle')}
        subtitle={t('capabilities.mcpHome.newBody')}
        primaryAction={{
          testID: 'settings.mcpServers.invitation.add',
          label: t('capabilities.mcpHome.browse'),
          onPress: () => openAdd({ modeKey: 'catalog' }),
        }}
        secondaryAction={{
          testID: 'settings.mcpServers.invitation.paste',
          label: t('capabilities.mcpHome.paste'),
          onPress: () => openAdd({ modeKey: 'paste' }),
        }}
      />
      <McpFoundBlock presentation="line" />
      <McpRegistryShelf
        shelf={home.shelf}
        servers={home.model.servers}
        onAdd={(card) =>
          openAdd({ modeKey: 'catalog', sourceId: card.sourceId, query: card.title })
        }
        onOpen={(serverId) => go(mcpServerRoute(serverId))}
      />
    </>
  );
});

/**
 * Needs you (lab n:home, S30-R05): below the map and its line, above the suggestions. Each server that needs the
 * person says its status, what fixing it gives back, and carries its one fix; the fix and the row both lead to
 * the server's page, where the fix lives (its Sign-in section, its key row, its Test).
 */
const NeedsYou = React.memo(function NeedsYou(
  props: Readonly<{
    attention: readonly McpHomeServer[];
    onOpen: (serverId: string) => void;
  }>,
) {
  if (props.attention.length === 0) return null;
  return (
    <ItemGroup
      testID="mcp.home.needs"
      title={t('capabilities.mcpHome.needsTitle')}
      titleAccessory={
        <Text variant="meta" style={styles.groupCount}>
          {String(props.attention.length)}
        </Text>
      }
    >
      {props.attention.map((server) => (
        <NeedsYouRow key={server.id} server={server} onOpen={props.onOpen} />
      ))}
    </ItemGroup>
  );
});

const NeedsYouRow = React.memo(function NeedsYouRow(
  props: Readonly<{ server: McpHomeServer; onOpen: (serverId: string) => void }>,
) {
  const { server, onOpen } = props;
  const open = React.useCallback(() => onOpen(server.id), [onOpen, server.id]);
  const fixLabel = server.status ? presentCapabilityStatus(server.status, 'row').fixLabel : undefined;
  return (
    <CapabilityRow
      testID={`mcp.home.needs.${server.id}`}
      title={server.title}
      description={needsConsequence(server)}
      mark={<HappierBrandMark brand={server.brandMark ?? { displayName: server.title }} pixelSize={20} externallyLabelled />}
      status={server.status}
      {...(fixLabel
        ? {
            action: (
              <RoundButton
                testID={`mcp.home.needs.${server.id}.fix`}
                size="small"
                display="secondary"
                title={fixLabel}
                onPress={open}
              />
            ),
          }
        : {})}
      onPress={open}
      onPreviewChange={(active) => setPreviewedMcpServer(active ? server.id : null)}
    />
  );
});

/**
 * Each row's own reason after the status word, from that server's facts: why its sign-in stopped (the sign-in
 * section's own words), the key it is missing, or what fixing it gives back (its tools, else what it is for).
 * Never one sentence repeated down the section. A run that failed keeps its reason under the status instead.
 */
function needsConsequence(server: McpHomeServer): string | null {
  const name = server.title;
  switch (server.status?.kind) {
    case 'signin':
      switch (server.signIn?.state) {
        case 'did_not_finish':
          return t('capabilities.mcpSignIn.didNotFinishBody');
        case 'no_machine_online':
          return t('capabilities.mcpSignIn.noMachineBody');
        case 'client_refused':
          return t('capabilities.mcpSignIn.clientRefusedBody');
        case 'invalid_client':
          return t('capabilities.mcpSignIn.invalidClientBody');
      }
      return givesBack(server);
    case 'expired':
      return server.signIn?.state === 'expired' && server.signIn.reason === 'address_changed'
        ? t('capabilities.mcpSignIn.addressChangedBody')
        : givesBack(server) ?? t('capabilities.mcpSignIn.expiredBody', { name });
    case 'revoked':
      return t('capabilities.mcpSignIn.revokedBody', { name });
    case 'more_access':
      return t('capabilities.mcpSignIn.moreAccessBody', { name });
    case 'key':
      return server.missingKeys.length > 0
        ? t('capabilities.mcpHome.needsKeyNamed', { names: joinList(server.missingKeys) })
        : t('capabilities.mcpHome.needsKey');
    default:
      return server.server.description ?? null;
  }
}

/** What signing in gives back: its tools when a Test counted them, else what the server is for. */
function givesBack(server: McpHomeServer): string | null {
  if (server.toolCount) return t('capabilities.mcpHome.needsAccountTools', { count: server.toolCount });
  return server.server.description?.trim() || t('capabilities.mcpHome.needsAccount');
}

/** The tether map and its legend. */
const ReachBlock = React.memo(function ReachBlock(
  props: Readonly<{
    home: McpHome;
    phone: boolean;
    loading: boolean;
    brandNew: boolean;
    suggestions: readonly Readonly<{
      key: string;
      iconUrl: string | null;
      title: string;
    }>[];
  }>,
) {
  const { home } = props;
  const go = useGo();
  const [width, setWidth] = React.useState(0);
  const onLayout = React.useCallback(
    (event: LayoutChangeEvent) =>
      setWidth(Math.round(event.nativeEvent.layout.width)),
    [],
  );
  // A rail row or a legend row being pointed at: one preview for the map and the present line.
  const previewed = usePreviewedMcpServer();
  // Leaving the homepage mid-hover never leaves a stale preview behind.
  React.useEffect(() => () => setPreviewedMcpServer(null), []);
  const sideBySide = !props.phone && width >= SIDE_BY_SIDE_MIN_PX;
  const mapWidth = props.phone ? width : MAP_BOX.width;
  const box = props.phone
    ? PHONE_MAP
    : {
        height: MAP_BOX.height,
        planetRadius: MAP_BOX.planetRadius,
        ring: MAP_BOX.ring,
      };
  const scene = React.useMemo(
    () =>
      layoutHomeOrbitRing(mapWidth, box.height, home.ring.marks, {
        pr: box.planetRadius,
        r: box.ring,
        markSize: RING_MARK_PX,
      }),
    [box.height, box.planetRadius, box.ring, home.ring.marks, mapWidth],
  );
  const byId = React.useMemo(
    () => new Map(home.servers.map((server) => [server.id, server])),
    [home.servers],
  );
  const suggestionsByKey = React.useMemo(
    () => new Map(props.suggestions.map((mark) => [mark.key, mark])),
    [props.suggestions],
  );
  const highlight = React.useMemo(
    () => (previewed && byId.has(previewed) ? new Set([previewed]) : null),
    [byId, previewed],
  );
  const renderMark = React.useCallback(
    (key: string) => {
      if (key === MCP_RING_MORE_KEY) {
        return (
          <Text variant="meta" emphasis="semiBold" style={styles.more}>
            {t('capabilities.mcpHome.more', { count: home.ring.more })}
          </Text>
        );
      }
      const server = byId.get(key);
      if (server)
        return (
          <McpServerMark
            transport={server.server.transport}
            size={RING_MARK_PX - 2}
          />
        );
      const suggestion = suggestionsByKey.get(key);
      if (suggestion?.iconUrl)
        return (
          <Image
            source={{ uri: suggestion.iconUrl }}
            style={styles.ringImage}
            accessibilityIgnoresInvertColors
          />
        );
      return <McpServerMark transport="http" size={RING_MARK_PX - 2} />;
    },
    [byId, home.ring.more, suggestionsByKey],
  );
  const open = React.useCallback(
    (serverId: string) => go(mcpServerRoute(serverId)),
    [go],
  );
  return (
    <View
      testID="mcp.home.reach"
      onLayout={onLayout}
      style={[styles.reach, sideBySide ? styles.reachRow : null]}
    >
      {width > 0 ? (
        <HomeOrbitMap
          testID="mcp.home.map"
          scene={scene}
          highlightKeys={highlight}
          renderRingMark={renderMark}
          accessibilityLabel={t('capabilities.mcpHome.mapLabel', {
            count: home.servers.length,
          })}
        />
      ) : (
        <View style={{ height: box.height }} />
      )}
      {props.phone ? null : (
        <View style={sideBySide ? styles.legendSide : styles.legendBelow}>
          {props.brandNew ? (
            <NewLegend />
          ) : (
            <Legend
              home={home}
              loading={props.loading}
              onPreview={setPreviewedMcpServer}
              onOpen={open}
            />
          )}
        </View>
      )}
    </View>
  );
});

/** The tether in words: a short solid or dotted rule before each group's name (lab `hm-lk`). */
function TetherKey(props: Readonly<{ kind: 'account' | 'machine' }>) {
  return (
    <View
      style={[styles.key, props.kind === 'machine' ? styles.keyDotted : null]}
    />
  );
}

function LegendHeader(props: Readonly<{ kind: 'account' | 'machine' }>) {
  return (
    <View style={[collectionListStyles.row, styles.legendHeader]}>
      <TetherKey kind={props.kind} />
      <Text variant="meta" emphasis="semiBold" style={styles.legendTitle}>
        {props.kind === 'account'
          ? t('capabilities.mcpHome.groupAccount')
          : t('capabilities.mcpHome.groupMachine')}
      </Text>
    </View>
  );
}

/** Brand new: the two ways a server reaches the agents, said before there is any (lab hm-A4). */
function NewLegend() {
  return (
    <View style={styles.legend}>
      <View style={styles.legendGroup}>
        <LegendHeader kind="account" />
        <Text variant="body" style={styles.newBody}>
          {t('capabilities.mcpHome.newAccountBody')}
        </Text>
      </View>
      <View style={styles.legendGroup}>
        <LegendHeader kind="machine" />
        <Text variant="body" style={styles.newBody}>
          {t('capabilities.mcpHome.newMachineBody')}
        </Text>
      </View>
    </View>
  );
}

function Legend(
  props: Readonly<{
    home: McpHome;
    loading: boolean;
    onPreview: (serverId: string | null) => void;
    onOpen: (serverId: string) => void;
  }>,
) {
  const { names } = useMcpAddPlaces();
  const groups = (['account', 'machine'] as const).filter(
    (kind) => props.home.legend[kind].length > 0,
  );
  return (
    <View style={styles.legend} testID="mcp.home.legend">
      {groups.map((kind) => (
        <View key={kind} style={styles.legendGroup}>
          <LegendHeader kind={kind} />
          {/* Rows at the rail's density, without a sheet: a legend, not a list to manage (lab hm-A). */}
          {props.home.legend[kind].map((server) => (
            <LegendRow
              key={server.id}
              server={server}
              names={names}
              onPreview={props.onPreview}
              onOpen={props.onOpen}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

/**
 * What a legend row says after the name (lab hm-A2): a local server's command and where it runs, how the
 * Account signed in to a remote one. A server that needs the person says it in its chip instead.
 */
function legendFact(server: McpHomeServer, names: WhereItsOnNames): string | undefined {
  if (server.status) return undefined;
  if (server.group === 'machine') {
    return [server.server.stdio?.command, shortWhereItsOn(server.bindings, names)].filter(Boolean).join(' · ') || undefined;
  }
  if (server.server.remote?.auth?.kind === 'oauth') {
    return server.identity
      ? t('capabilities.mcpHome.factAs', { identity: server.identity })
      : t('capabilities.mcpHome.factSignedIn');
  }
  const keyed = Object.values(server.server.remote?.headers ?? {}).some(
    (ref) => ref.t === 'savedSecret' || ref.t === 'template',
  );
  return keyed ? t('capabilities.mcpHome.factKey') : undefined;
}

const LegendRow = React.memo(function LegendRow(
  props: Readonly<{
    server: McpHomeServer;
    names: WhereItsOnNames;
    onPreview: (serverId: string | null) => void;
    onOpen: (serverId: string) => void;
  }>,
) {
  const { server, names, onPreview, onOpen } = props;
  const open = React.useCallback(() => onOpen(server.id), [onOpen, server.id]);
  const { status } = server;
  // Healthy and untested is quiet: only a known tool count speaks. A problem says only its amber word on the name's
  // line (lab n:home): its fix is the Needs you row, on wide and phone alike (RETAIN M4).
  const action = status ? (
    <CapabilityStatusChip
      status={status}
      placement="catalog"
      testID={`mcp.home.legend.${server.id}:status`}
    />
  ) : server.toolCount === null ? undefined : (
    <Text variant="meta" style={styles.tools}>
      {toolCountText(server.toolCount)}
    </Text>
  );
  const fact = legendFact(server, names);
  return (
    <CapabilityRow
      testID={`mcp.home.legend.${server.id}`}
      title={server.title}
      {...(fact ? { qualifier: fact } : {})}
      mark={<McpServerMark transport={server.server.transport} size={16} />}
      {...(action ? { action } : {})}
      density="rail"
      divider={false}
      onPress={open}
      onPreviewChange={(active) => onPreview(active ? server.id : null)}
    />
  );
});

/** One line of the present; while a server is previewed, the line says how that one reaches you. */
function PresentLine(props: Readonly<{ home: McpHome }>) {
  const { home } = props;
  const railPreview = usePreviewedMcpServer();
  const previewed = railPreview
    ? (home.servers.find((server) => server.id === railPreview) ?? null)
    : null;
  let text: string;
  if (previewed) text = previewLine(previewed);
  else if (home.present.servers === 0)
    text = t('capabilities.mcpHome.presentNone');
  else if (!home.present.toolsKnown)
    text = t('capabilities.mcpHome.presentNoTools', {
      count: home.present.servers,
    });
  else
    text = t('capabilities.mcpHome.present', {
      servers: home.present.servers,
      tools: home.present.tools,
      tokens: formatCapabilityCount(home.present.tokens),
    });
  return (
    <Text
      testID="mcp.home.sentence"
      variant="reading"
      style={styles.sentence}
      accessibilityLiveRegion="polite"
    >
      {previewed ? (
        <Text
          variant="reading"
          emphasis="semiBold"
          style={styles.count}
        >{`${previewed.title} · `}</Text>
      ) : null}
      {withCounts(text, 'p')}
      {!previewed && home.needsYou > 0 ? (
        <Text variant="reading" style={styles.attention}>
          {withCounts(
            t('capabilities.mcpHome.needYou', { count: home.needsYou }),
            'a',
            styles.attention,
          )}
        </Text>
      ) : null}
    </Text>
  );
}

/** The one tool-count wording every list shares (the facts line's). */
function toolCountText(count: number): string {
  return t('capabilities.facts.toolCount', { count, shown: formatCapabilityCount(count) });
}

function previewLine(server: McpHomeServer): string {
  if (server.off) return t('capabilities.mcpHome.previewOff');
  if (server.status?.kind === 'key')
    return t('capabilities.mcpHome.previewNeedsKey');
  if (server.status?.kind === 'signin')
    return t('capabilities.mcpHome.previewSignIn');
  if (server.status)
    return t('capabilities.mcpHome.previewExpired');
  const tools =
    server.toolCount === null
      ? ''
      : ` · ${toolCountText(server.toolCount)}`;
  if (server.group === 'machine')
    return `${t('capabilities.mcpHome.previewMachine')}${tools}`;
  if (server.server.remote?.auth?.kind === 'oauth') {
    return `${server.identity ? t('capabilities.mcpHome.previewSignedInAs', { identity: server.identity }) : t('capabilities.mcpHome.previewSignedIn')}${tools}`;
  }
  return `${t('capabilities.mcpHome.previewKey')}${tools}`;
}

/** The line's counts read as facts: in ink, a step heavier (lab `hm-num`). */
function withCounts(
  text: string,
  key: string,
  style?: object,
): React.ReactNode[] {
  return text.split(/(\d[\d.,]*k?)/).map((part, index) =>
    index % 2 === 1 ? (
      <Text
        key={`${key}${index}`}
        variant="reading"
        emphasis="semiBold"
        style={style ?? styles.count}
      >
        {part}
      </Text>
    ) : (
      part
    ),
  );
}

const styles = StyleSheet.create((theme) => ({
  inset: { paddingHorizontal: resolveItemGroupContentHorizontalInsetPx() },
  reach: { gap: theme.space.s16, marginTop: theme.space.s8, alignItems: 'center' },
  reachRow: { flexDirection: 'row', alignItems: 'center', gap: REACH_GAP_PX },
  legendSide: { flex: 1, minWidth: 0 },
  legendBelow: { alignSelf: 'stretch' },
  legend: { gap: theme.space.s16 },
  legendGroup: { gap: theme.space.s4 },
  legendHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
    minHeight: 0,
    paddingVertical: theme.space.s4,
  },
  legendTitle: { color: theme.colors.text.secondary },
  key: {
    width: 20,
    height: 0,
    borderTopWidth: 1.2,
    borderColor: theme.colors.text.secondary,
    opacity: 0.7,
  },
  keyDotted: { borderStyle: 'dotted' },
  newBody: { color: theme.colors.text.secondary, paddingLeft: theme.space.s24 },
  groupCount: { color: theme.colors.text.secondary, fontVariant: ['tabular-nums'] },
  summaryEnd: { marginBottom: theme.space.s16 },
  tools: { color: theme.colors.text.secondary, fontVariant: ['tabular-nums'] },
  more: { color: theme.colors.text.secondary, fontVariant: ['tabular-nums'] },
  ringImage: { width: RING_MARK_PX - 2, height: RING_MARK_PX - 2 },
  sentence: {
    color: theme.colors.text.secondary,
    marginTop: theme.space.s16,
    marginBottom: theme.space.s8,
  },
  count: { color: theme.colors.text.primary, fontVariant: ['tabular-nums'] },
  attention: { color: theme.colors.state.warning.foreground },
  acts: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
    marginTop: theme.space.s16,
    marginBottom: theme.space.s16,
  },
}));
