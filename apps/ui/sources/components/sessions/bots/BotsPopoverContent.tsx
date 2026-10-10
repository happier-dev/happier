import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useShallow } from 'zustand/react/shallow';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import {
  RailPopoverRoster,
  resolveRailPopoverRosterListMaxHeight,
} from '@/components/navigation/shell/sidebarFooter/RailPopoverRoster';
import { buildSessionListFilterHomeOptions } from '@/components/sessions/shell/search/useSessionListViewFilterController';
import {
  buildSessionListFilterQueryHomes,
  resolveSessionListViewContextDefaults,
} from '@/components/sessions/shell/search/sessionListViewFilters';
import { SessionItem } from '@/components/sessions/shell/SessionItem';
import { filterCollapsedSessionListItems } from '@/components/sessions/shell/filterCollapsedSessionListItems';
import { selectSessionReportSubtree } from '@/components/sessions/work/reportSubtree';
import { nestSessionListReports } from '@/sync/domains/session/listing/nestSessionListReports';
import {
  buildSessionListRowViewModel,
  resolveSessionListRowViewModelAdjacency,
  type SessionListRowViewModel,
} from '@/components/sessions/shell/sessionListRowViewModels';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Icon } from '@/components/ui/icons/Icon';
import { MENU_ROW_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import {
  useSessionListRelativeNowMs,
  useSessionListRuntimeNowMs,
} from '@/hooks/session/sessionListRuntimeClock';
import { useSessionListSelectionState } from '@/hooks/session/useSessionListSelectionState';
import { useVisibleSessionListPaneState } from '@/hooks/session/useVisibleSessionListPaneState';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useSessionListQueryHomeSupportByServerId, useSessionListQuerySourceState } from '@/sync/domains/session/listing/useSessionListQuerySourceState';
import { buildSessionListIndexNodeId, type SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { storage, useLocalSettingMutable, useSessionListRowRenderablesForItems } from '@/sync/domains/state/storage';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { AskHappierMark, AskHappierOfferCard } from './AskHappierOfferCard';
import {
  useAskHappierOfferChoices,
  useAskHappierOfferVisible,
  useAskHappierOpener,
} from './useAskHappierOffer';
import { classifyBotActivity } from './botActivity';
import { BOTS_GLYPH } from './botsGlyph';
import { openNewBotDraft } from './newBotDraft';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';

type SessionIndexItem = Extract<SessionListIndexItem, { type: 'session' }>;

const NO_REACHABLE_DISPLAY = new Map();
const NO_PINNED_KEYS: ReadonlySet<string> = new Set();
const NO_TAGS: Record<string, string[]> = {};
const NO_COLLAPSED_GROUPS: Readonly<Record<string, boolean>> = {};
/** The plus beside the invite's New bot, on the small button's text. */
const EMPTY_ACTION_GLYPH_SIZE_PX = 14;

/**
 * The exact Homes the ordinary Sessions list shows, each asked for its Bots with the ordinary query
 * owner (the view state adds the Bot facet, inactive rows and row-only membership). Homes that cannot
 * answer a structural query leave the roster on the ordinary loaded rows.
 */
function useBotsRosterQueryHomes() {
  const selection = useSessionListSelectionState();
  const mountedHomeServerIds = React.useMemo(() => {
    const values = selection.allowedServerIds?.length
      ? selection.allowedServerIds
      : selection.activeServerId
        ? [selection.activeServerId]
        : [];
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  }, [selection.activeServerId, selection.allowedServerIds]);
  const support = useSessionListQueryHomeSupportByServerId(
    mountedHomeServerIds,
    true,
  );
  const queryEnabled = mountedHomeServerIds.some(
    (serverId) => support[serverId] === true,
  );
  return React.useMemo(() => {
    if (!queryEnabled) return undefined;
    const { defaults } = resolveSessionListViewContextDefaults(
      { kind: 'global' },
      mountedHomeServerIds,
      'all',
    );
    return buildSessionListFilterQueryHomes(defaults, {
      storage: 'active',
      includeInactive: true,
      mountedHomeServerIds,
    });
  }, [mountedHomeServerIds, queryEnabled]);
}

function readRosterCounts(
  rows: readonly SessionListRowViewModel[],
): Readonly<{ needsYou: number; working: number }> {
  let needsYou = 0;
  let working = 0;
  for (const row of rows) {
    const activity = classifyBotActivity(
      row.sessionStatus?.awareness.operational.primary,
    );
    if (activity === 'needsYou') needsYou += 1;
    else if (activity === 'working') working += 1;
  }
  return { needsYou, working };
}

function useRosterRows(items: readonly SessionIndexItem[]) {
  const renderables = useSessionListRowRenderablesForItems(items);
  const relativeNowMs = useSessionListRelativeNowMs(true);
  const runtimeNowMs = useSessionListRuntimeNowMs(true);
  return React.useMemo(() => items.map((item, index) => buildSessionListRowViewModel({
    item, adjacency: resolveSessionListRowViewModelAdjacency(items, index),
    unscopedSelectionIsUnique: false, reachableSessionDisplayById: NO_REACHABLE_DISPLAY,
    rowRenderableByKey: renderables, relativeNowMs, runtimeNowMs,
    workingTextMode: 'static', identityDisplay: 'avatar', hasMultipleMachines: false,
    pinnedSessionKeys: NO_PINNED_KEYS, sessionTags: NO_TAGS, selectedSessionId: null,
    showServerBadge: false, showPinnedServerBadge: false,
  })), [items, relativeNowMs, renderables, runtimeNowMs]);
}

/** Only an expanded lead mounts its exact-Home subtree query. Shared rows and reportsTo own membership. */
function BotRosterReports(props: Readonly<{
  lead: SessionListRenderableSession;
  item: SessionIndexItem;
}>) {
  const serverId = props.item.serverId ?? '';
  const homeIds = React.useMemo(() => [serverId], [serverId]);
  const support = useSessionListQueryHomeSupportByServerId(homeIds, true);
  const homes = React.useMemo(() => [{ serverId, queryMembership: 'rowOnly' as const, query: {
    v: 1 as const, storage: 'active' as const, includeInactive: true,
    scope: 'all_accessible' as const, attention: 'any' as const, audiences: [], tagIds: [],
    underSessionId: props.lead.id,
  } }], [props.lead.id, serverId]);
  const query = useSessionListQuerySourceState({ enabled: support[serverId] === true, homes });
  const state = query.statesByServerId[serverId];
  const cursor = state?.phase === 'ready' && (state.hasNext || state.attentionHasNext)
    ? `${state.nextCursor}:${state.attentionNextCursor}` : '';
  React.useEffect(() => {
    if (cursor) fireAndForget(query.loadNext(), { tag: 'BotsRoster.reports.loadNext' });
  }, [cursor, query]);
  return <>
    {support[serverId] === true && !query.coverageComplete ? <SurfaceFreshnessLine
      testID={`bots-roster.reports:${props.lead.id}.partial`}
      reason={t('bots.partial')}
      action={{ label: t('common.retry'), onPress: () => fireAndForget(query.refresh(), { tag: 'BotsRoster.reports.retry' }) }}
    /> : null}
  </>;
}

/**
 * The Bots roster (lab `b-rail A/M/S/G`): every Bot of the Homes the app shows, as the ordinary
 * Session rows (seeded avatar, the awareness line, Talk and the shared More on hover), then New bot
 * and Ask Happier. Mounted only while the popover or sheet is open; it never wakes a machine and
 * never subscribes to transcripts.
 */
export function BotsPopoverContent(
  props: Readonly<{
    close: () => void;
    maxHeight: number;
    presentation?: 'popover' | 'sheet';
  }>,
) {
  const { theme } = useUnistyles();
  const styles = stylesheet;
  const [collapsedPreference, setCollapsedPreference] = useLocalSettingMutable('collapsedGroupKeysV1');
  const collapsed = collapsedPreference ?? NO_COLLAPSED_GROUPS;
  const collapsedRef = React.useRef(collapsed);
  collapsedRef.current = collapsed;
  const setCollapsed = React.useCallback((nodeId: string, value: boolean) => {
    setCollapsedPreference({ ...collapsedRef.current, [nodeId]: value });
  }, [setCollapsedPreference]);
  const queryHomes = useBotsRosterQueryHomes();
  const pane = useVisibleSessionListPaneState('all', {
    botsRoster: true,
    queryHomes,
    sessionListSurfaceDataActive: true,
  });
  const botItems = React.useMemo(
    () =>
      (pane.visibleSessionListIndex ?? []).filter(
        (item): item is SessionIndexItem => item.type === 'session',
      ),
    [pane.visibleSessionListIndex],
  );
  const botRows = useRosterRows(botItems);
  const descendants = storage(useShallow(state => {
    const records: Record<string, Session> = {};
    for (const item of botItems) {
      if (collapsed[buildSessionListIndexNodeId(item)] !== false) continue;
      for (const session of selectSessionReportSubtree(state.sessions, item.sessionId, item.serverId ?? null, state.sessionListRowsByServerId)) {
        records[buildSessionListIndexNodeId({ type: 'session', serverId: item.serverId, sessionId: session.id })] = session;
      }
    }
    return records;
  }));
  const items = React.useMemo(() => {
    const byHome = new Map<string, Map<string, SessionIndexItem>>();
    const records = new Map<string, SessionListRenderableSession>();
    const add = (item: SessionIndexItem, session: SessionListRenderableSession | null) => {
      const home = item.serverId ?? '';
      const group = byHome.get(home) ?? new Map<string, SessionIndexItem>();
      const key = buildSessionListIndexNodeId(item);
      group.set(key, { ...item, groupKey: JSON.stringify(['bots-roster', home]) });
      byHome.set(home, group);
      if (session) records.set(key, session);
    };
    botItems.forEach((item, index) => add(item, botRows[index]!.session));
    for (const [key, session] of Object.entries(descendants)) {
      if (records.has(key)) continue;
      add({ type: 'session', sessionId: session.id, serverId: session.serverId }, session);
    }
    const source = [...byHome.values()].flatMap(group => [...group.values()]);
    return filterCollapsedSessionListItems(nestSessionListReports(source, (serverId, sessionId) => records.get(
      buildSessionListIndexNodeId({ type: 'session', serverId: serverId ?? undefined, sessionId }),
    ) ?? null), collapsed).filter((item): item is SessionIndexItem => item.type === 'session');
  }, [botItems, botRows, collapsed, descendants]);
  const rows = useRosterRows(items);
  const counts = React.useMemo(() => readRosterCounts(botRows), [botRows]);

  // Page to the end of every Home's Bot candidates and attention frontier, one page at a time.
  const query = pane.query;
  const pagingSignature = query?.active
    ? Object.entries(query.statesByServerId)
        .map(([serverId, state]) =>
          state &&
          state.phase === 'ready' &&
          (state.hasNext || state.attentionHasNext)
            ? `${serverId}:${state.nextCursor}:${state.attentionNextCursor}`
            : '',
        )
        .join('|')
    : '';
  React.useEffect(() => {
    if (!query?.active || !pagingSignature.replace(/\|/g, '')) return;
    fireAndForget(query.loadNext(), { tag: 'BotsRoster.loadNext' });
  }, [pagingSignature, query]);

  const presentation = pane.queryPresentation;
  const offlineHome =
    presentation?.kind === 'partial'
      ? (presentation.unavailableHomes.find((home) => home.reason === 'offline')
          ?.serverId ?? null)
      : null;
  const offlineHomeLabel = React.useMemo(
    () =>
      offlineHome
        ? (buildSessionListFilterHomeOptions([offlineHome])[0]?.label ??
          offlineHome)
        : null,
    [offlineHome],
  );
  // Still paging (a Home loading or a cursor left): the roster is not settled yet.
  const paging = query?.active === true && Object.values(query.statesByServerId).some((state) => state !== undefined
    && (state.phase === 'idle' || state.phase === 'loading'
      || (state.phase === 'ready' && (state.hasNext || state.attentionHasNext))));
  // Settled but not whole (locked or withheld candidates): say so, never call it a complete empty roster.
  const incomplete = !paging && presentation?.kind === 'ready' && !presentation.complete;
  const failed =
    incomplete ||
    presentation?.kind === 'error' ||
    (presentation?.kind === 'partial' && !offlineHome);
  const loading =
    rows.length === 0 &&
    (pane.showLoading || presentation?.kind === 'initial_loading' || paging);
  const empty = rows.length === 0 && !loading && !offlineHome && presentation?.kind !== 'error';

  const offerVisible = useAskHappierOfferVisible();
  const offer = useAskHappierOfferChoices();
  const openAskHappier = useAskHappierOpener();
  const { execute: executeAuthoring } = useMountedActionExecution(useAccountSettingsScope());
  const { close } = props;
  const newBot = React.useCallback(() => {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (lifetime)
      fireAndForget(openNewBotDraft(lifetime, executeAuthoring).then(result => { if (result.kind === 'opened') close(); }), { tag: 'BotsRoster.newBot' });
  }, [close, executeAuthoring]);
  const askHappier = React.useCallback(() => {
    fireAndForget(openAskHappier().then(result => { if (result.kind === 'opened' || result.kind === 'authenticationRequired') close(); }), { tag: 'BotsRoster.askHappier' });
  }, [close, openAskHappier]);
  const startOffer = React.useCallback(() => {
    fireAndForget(openAskHappier().then(result => { if (result.kind === 'opened' || result.kind === 'authenticationRequired') close(); }), { tag: 'BotsRoster.startOffer' });
  }, [close, openAskHappier]);
  const retry = React.useCallback(() => {
    if (query) fireAndForget(query.refresh(), { tag: 'BotsRoster.retry' });
  }, [query]);

  const iconColor = theme.colors.text.secondary;
  const footerActions = [
    {
      id: 'new-bot',
      testID: 'bots-roster.new-bot',
      label: t('bots.new'),
      icon: (
        <Icon
          name="plus"
          size={MENU_ROW_METRICS.iconGlyphSizePx}
          color={iconColor}
        />
      ),
      right: (
        <Text style={styles.hint} numberOfLines={1}>
          {t('bots.roster.newHint')}
        </Text>
      ),
      onPress: newBot,
    },
    {
      id: 'ask-happier',
      testID: 'bots-roster.ask-happier',
      label: t('bots.guide.offer'),
      subtitle: t('bots.guide.menuSubtitle'),
      icon: <AskHappierMark size={MENU_ROW_METRICS.iconGlyphSizePx + 2} />,
      onPress: askHappier,
    },
  ];

  if (empty) {
    return (
      <View testID="bots-roster" style={styles.emptyRoot}>
        <EmptyState
          layout="centered"
          size="details"
          iconName={BOTS_GLYPH}
          title={t('bots.empty.title')}
          subtitle={t('bots.empty.body')}
          testID="bots-roster.empty"
          // One primary per view: with the offer showing, its Start is the primary.
          action={
            <RoundButton
              testID="bots-roster.empty.new-bot"
              size="small"
              display={offerVisible ? 'secondary' : 'default'}
              title={t('bots.new')}
              leading={
                <Icon
                  name="plus"
                  size={EMPTY_ACTION_GLYPH_SIZE_PX}
                  color={
                    offerVisible
                      ? theme.colors.text.secondary
                      : theme.colors.button.primary.tint
                  }
                />
              }
              onPress={newBot}
            />
          }
        />
        {failed ? (
          <View style={styles.line}>
            <SurfaceFreshnessLine
              testID="bots-roster.partial"
              tone="warning"
              reason={t('bots.partial')}
              action={{ label: t('common.retry'), onPress: retry }}
            />
          </View>
        ) : null}
        {offerVisible ? (
          <>
            <View style={styles.divider} />
            <AskHappierOfferCard
              compact={props.presentation === 'sheet'}
              testID="bots-roster.offer"
              onStart={startOffer}
              onNotNow={offer.notNow}
              onDontShowAgain={offer.dontShowAgain}
            />
          </>
        ) : null}
      </View>
    );
  }

  const summary = [
    counts.needsYou > 0
      ? t('bots.roster.needsYou', { count: counts.needsYou })
      : null,
    counts.working > 0
      ? t('bots.roster.working', { count: counts.working })
      : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <RailPopoverRoster
      testID="bots-roster"
      title={t('bots.title')}
      actions={footerActions}
      summary={
        summary ? (
          <View style={styles.summary}>
            {counts.needsYou > 0 ? (
              <StatusDot color={theme.colors.state.warning.foreground} />
            ) : null}
            <Text style={styles.summaryText} numberOfLines={1}>
              {summary}
            </Text>
          </View>
        ) : null
      }
    >
      {offlineHomeLabel ? (
        <View style={styles.line}>
          <SurfaceFreshnessLine
            testID="bots-roster.offline"
            // With nothing retained there is no "last known" roster to promise.
            reason={
              rows.length > 0
                ? t('bots.offline', { home: offlineHomeLabel })
                : t('bots.offlineEmpty', { home: offlineHomeLabel })
            }
            action={
              rows.length > 0
                ? undefined
                : { label: t('common.retry'), onPress: retry }
            }
          />
        </View>
      ) : null}
      <ScrollView
        style={{
          maxHeight: resolveRailPopoverRosterListMaxHeight(props.maxHeight),
        }}
        keyboardShouldPersistTaps="always"
        testID="bots-roster.list"
      >
        {rows.map((row, index) =>
          row.session ? (
            <React.Fragment key={row.sessionKey ?? items[index]!.sessionId}>
            <SessionItem
              rowViewModel={row}
              session={row.session}
              serverId={items[index]!.serverId ?? undefined}
              compact
              embedded
              embeddedIsLast={index === rows.length - 1}
              showTalkAction
              actionMenuSurface="botsRoster"
              reportsDepth={items[index]!.reportsDepth}
              reportsDisclosure={(row.session.reports?.total ?? 0) > 0
                ? (collapsed[buildSessionListIndexNodeId(items[index]!)] ?? (row.session.metadata?.bot?.kind === 'bot')) ? 'collapsed' : 'expanded'
                : undefined}
              onSetReportsCollapsed={setCollapsed}
              onOpened={close}
            />
            {(row.session.reports?.total ?? 0) > 0 && collapsed[buildSessionListIndexNodeId(items[index]!)] === false
              ? <BotRosterReports lead={row.session} item={items[index]!} />
              : null}
            </React.Fragment>
          ) : null,
        )}
        {loading ? (
          <EmptyState
            layout="line"
            testID="bots-roster.loading"
            title={t('bots.loading')}
          />
        ) : null}
      </ScrollView>
      {failed ? (
        <View style={styles.line}>
          <SurfaceFreshnessLine
            testID="bots-roster.partial"
            tone="warning"
            reason={t('bots.partial')}
            action={{ label: t('common.retry'), onPress: retry }}
          />
        </View>
      ) : null}
    </RailPopoverRoster>
  );
}

const stylesheet = StyleSheet.create((theme) => ({
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 1,
  },
  summaryText: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
  hint: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.tertiary,
  },
  line: {
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginHorizontal: 12,
    backgroundColor: theme.colors.border.default,
  },
  emptyRoot: {
    paddingBottom: 12,
  },
}));
