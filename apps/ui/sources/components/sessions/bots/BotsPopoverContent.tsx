import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useShallow } from 'zustand/react/shallow';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { readSessionLiveManagedSessionCountV1 } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';

import {
  RAIL_POPOVER_ROSTER_LIST_STYLE,
  RailPopoverRoster,
} from '@/components/navigation/shell/sidebarFooter/RailPopoverRoster';
import {
  buildSessionListFilterQueryHomes,
  resolveSessionListFilterOrdinaryPageAdapter,
  resolveSessionListViewContextDefaults,
} from '@/components/sessions/shell/search/sessionListViewFilters';
import { SessionItem } from '@/components/sessions/shell/SessionItem';
import { useSessionListIdentityDisplay } from '@/components/sessions/shell/SessionListIdentity';
import { filterCollapsedSessionListItems } from '@/components/sessions/shell/filterCollapsedSessionListItems';
import { readSessionRelationRecord, selectSessionReportIds } from '@/components/sessions/work/reportSubtree';
import { resolveSessionListHomeKey } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { EMPTY_SESSION_RELATION_FACTS } from '@/sync/store/domains/sessionRelations';
import { nestSessionListReports } from '@/sync/domains/session/listing/nestSessionListReports';
import {
  buildSessionListRowViewModel,
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
import { getServerProfileById, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { useHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { useSessionListQueryHomeSupportByServerId, useSessionListQuerySourceState } from '@/sync/domains/session/listing/useSessionListQuerySourceState';
import { buildSessionListIndexNodeId, type SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { storage, useSessionListRowRenderablesForItems } from '@/sync/domains/state/storage';
import { collapsedGroupsState, useCollapsedGroupKeys } from '@/sync/domains/state/disclosureUiState';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { readSessionPresentationRecord, readSessionPresentationServerId, readSessionPresentationInputDisplay,
  readSessionPresentationInputRelations, type SessionRelationRecord } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { AskHappierMark, AskHappierOfferCard } from './AskHappierOfferCard';
import {
  useAskHappierOfferChoices,
  useAskHappierOfferVisible,
  useAskHappierOpener,
} from './useAskHappierOffer';
import { readBotActivity, type BotActivity } from './botActivity';
import { useOrderedBots } from './botsSummary';
import { BOTS_GLYPH } from './botsGlyph';
import { BotRosterReadiness } from './BotRosterReadiness';
import { openNewBotDraft } from './newBotDraft';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';

type SessionIndexItem = Extract<SessionListIndexItem, { type: 'session' }>;
type BotRosterRow = SessionListRowViewModel & Readonly<{ botActivity: BotActivity }>;

const NO_REACHABLE_DISPLAY = new Map();
const NO_PINNED_KEYS: ReadonlySet<string> = new Set();
const NO_TAGS: Record<string, string[]> = {};
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
  return React.useMemo(() => {
    const { defaults } = resolveSessionListViewContextDefaults(
      { kind: 'global' },
      mountedHomeServerIds,
      'all',
    );
    const filters = { ...defaults, bot: 'bot' as const };
    return buildSessionListFilterQueryHomes(filters, {
      storage: 'active',
      includeInactive: true,
      mountedHomeServerIds,
    }).map(home => ({
      ...home,
      ordinaryAdapter: resolveSessionListFilterOrdinaryPageAdapter(filters, home.query),
    }));
  }, [mountedHomeServerIds]);
}

function readRosterCounts(
  rows: readonly BotRosterRow[],
): Readonly<{ needsYou: number; working: number }> {
  let needsYou = 0;
  let working = 0;
  for (const row of rows) {
    const activity = row.botActivity;
    if (activity === 'needsYou') needsYou += 1;
    else if (activity === 'working') working += 1;
  }
  return { needsYou, working };
}

function useRosterRows(items: readonly SessionIndexItem[]) {
  const renderables = useSessionListRowRenderablesForItems(items);
  const relativeNowMs = useSessionListRelativeNowMs(true);
  const runtimeNowMs = useSessionListRuntimeNowMs(true);
  // The rows draw the identity the person chose for the Sessions list, not a roster-only mark.
  const identityDisplay = useSessionListIdentityDisplay();
  const rows = React.useMemo(() => items.map((item) => {
    const row = buildSessionListRowViewModel({
    item,
    unscopedSelectionIsUnique: false, reachableSessionDisplayById: NO_REACHABLE_DISPLAY,
    rowRenderableByKey: renderables, relativeNowMs, runtimeNowMs,
    identityDisplay,
    pinnedSessionKeys: NO_PINNED_KEYS, sessionTags: NO_TAGS, selectedSessionId: null,
    showServerBadge: false, showPinnedServerBadge: false,
    });
    return row;
  }), [identityDisplay, items, relativeNowMs, renderables, runtimeNowMs]);
  return { rows, runtimeNowMs };
}

/** Only an expanded lead mounts its exact-Home subtree query. Shared rows and manager own membership. */
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
    if (cursor) fireAndForget(query.loadNext(), { tag: 'BotsRoster.managedSessions.loadNext' });
  }, [cursor, query]);
  return <>
    {support[serverId] === true && !query.coverageComplete ? <SurfaceFreshnessLine
      testID={`bots-roster.managedSessions:${props.lead.id}.partial`}
      reason={t('bots.partial')}
      action={{ label: t('common.retry'), onPress: () => fireAndForget(query.retry(), { tag: 'BotsRoster.managedSessions.retry' }) }}
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
  const setCollapsed = React.useCallback((nodeId: string, value: boolean) => {
    collapsedGroupsState.set(nodeId, value);
  }, []);
  const queryHomes = useBotsRosterQueryHomes();
  const pane = useVisibleSessionListPaneState('all', {
    botsRoster: true,
    queryHomes,
    sessionListSurfaceDataActive: true,
  });
  // Queries discover/open rows and report freshness. The same loaded-Bot owner
  // used by Home decides membership; personal list filters cannot remove a Bot here.
  const orderedBots = useOrderedBots();
  const botItems = React.useMemo(() => orderedBots.map((bot): SessionIndexItem => ({
    type: 'session', serverId: bot.serverId, sessionId: bot.sessionId,
  })), [orderedBots]);
  const { rows: loadedBotRows } = useRosterRows(botItems);
  const botRows = React.useMemo(() => loadedBotRows.map((row, index): BotRosterRow => ({
    ...row, botActivity: orderedBots[index]!.activity,
  })), [loadedBotRows, orderedBots]);
  const botDisclosureKeys = React.useMemo(() => botItems.map(buildSessionListIndexNodeId), [botItems]);
  const rootCollapsed = useCollapsedGroupKeys(botDisclosureKeys);
  // Activity and titles may reorder/repaint Bots without changing expanded topology demand.
  // Select only primitive addresses, in identity order, before reading relationship facts.
  const expandedAddresses = useShallow((items: readonly SessionIndexItem[]) => items
    .filter(item => rootCollapsed[buildSessionListIndexNodeId(item)] === false)
    .map(item => ({ item, key: buildSessionListIndexNodeId(item) }))
    .sort((a, b) => a.key.localeCompare(b.key))
    .flatMap(({ item }) => [item.serverId ?? '', item.sessionId]))(botItems);
  const expandedBots = React.useMemo(() => {
    const items: SessionIndexItem[] = [];
    for (let index = 0; index < expandedAddresses.length; index += 2) {
      items.push({ type: 'session', serverId: expandedAddresses[index] || undefined, sessionId: expandedAddresses[index + 1]! });
    }
    return items;
  }, [expandedAddresses]);
  const relationInputs = storage(useShallow(state => expandedBots.map(item => {
    const key = resolveSessionListHomeKey(state.sessionRelationsByServerId, item.serverId);
    return key ? state.sessionRelationsByServerId[key] ?? EMPTY_SESSION_RELATION_FACTS : EMPTY_SESSION_RELATION_FACTS;
  })));
  const descendantItems = React.useMemo(() => expandedBots.flatMap((item, index) =>
    selectSessionReportIds(relationInputs[index]!, item.sessionId).map(sessionId => ({
      type: 'session' as const, serverId: item.serverId, sessionId,
    }))), [expandedBots, relationInputs]);
  // Exact current rows and hydrated bases remain separate from the topology memo.
  const descendantInputs = storage(useShallow(state => descendantItems.flatMap(item => {
    const input = readSessionRelationRecord(state.sessions, item.sessionId, item.serverId ?? null, state.sessionListRowsByServerId);
    return input ? [readSessionPresentationRecord(input), 'record' in input ? input.baseSession : undefined] : [undefined, undefined];
  })));
  const descendants = React.useMemo(() => {
    const records: Record<string, SessionRelationRecord> = {};
    descendantItems.forEach((item, index) => {
      const record = descendantInputs[index * 2];
      if (!record) return;
      const base = descendantInputs[index * 2 + 1];
      records[buildSessionListIndexNodeId(item)] = { record,
        serverId: item.serverId ? resolveServerProfileScopeIdForIdentifier(item.serverId) : undefined,
        baseSession: base && 'agentState' in base ? base : undefined };
    });
    return records;
  }, [descendantInputs, descendantItems]);
  const descendantDisclosureKeys = React.useMemo(() => Object.keys(descendants), [descendants]);
  const descendantCollapsed = useCollapsedGroupKeys(descendantDisclosureKeys);
  const collapsed = React.useMemo(() => ({ ...rootCollapsed, ...descendantCollapsed }), [rootCollapsed, descendantCollapsed]);
  const items = React.useMemo(() => {
    const byHome = new Map<string, Map<string, SessionIndexItem>>();
    const records = new Map<string, NonNullable<ReturnType<Parameters<typeof nestSessionListReports>[1]>>>();
    const add = (item: SessionIndexItem, session: ReturnType<Parameters<typeof nestSessionListReports>[1]>) => {
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
      const record = readSessionPresentationRecord(session);
      const display = readSessionPresentationInputDisplay(session);
      add({ type: 'session', sessionId: record.id, serverId: readSessionPresentationServerId(session) },
        { ...readSessionPresentationInputRelations(session), metadata: display.metadata });
    }
    const source = [...byHome.values()].flatMap(group => [...group.values()]);
    return filterCollapsedSessionListItems(nestSessionListReports(source, (serverId, sessionId) => records.get(
      buildSessionListIndexNodeId({ type: 'session', serverId: serverId ?? undefined, sessionId }),
    ) ?? null), collapsed).filter((item): item is SessionIndexItem => item.type === 'session');
  }, [botItems, botRows, collapsed, descendants]);
  const presentedRows = useRosterRows(items);
  const rows = React.useMemo(() => presentedRows.rows.map((row): BotRosterRow => ({ ...row,
    botActivity: row.session ? readBotActivity(row.session, presentedRows.runtimeNowMs, row.sessionStatus ?? undefined) : 'quiet',
  })), [presentedRows.rows, presentedRows.runtimeNowMs]);
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
  useServerProfilesGeneration();
  const offlineHomeLabel = useHomeDisplayLabel(offlineHome ? getServerProfileById(offlineHome) : null);
  // Still paging (a Home loading or a cursor left): the roster is not settled yet.
  const paging = query?.active === true && Object.values(query.statesByServerId).some((state) => state !== undefined
    && (state.phase === 'idle' || state.phase === 'loading'
      || (state.phase === 'ready' && (state.hasNext || state.attentionHasNext))));
  // Settled but not whole (locked or withheld candidates): say so, never call it a complete empty roster.
  const incomplete = !paging && presentation?.kind === 'ready' && !presentation.complete;
  const failed =
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
    if (query) fireAndForget(query.retry(), { tag: 'BotsRoster.retry' });
  }, [query]);

  const freshnessLine = failed || incomplete ? (
    <View style={styles.line}>
      <SurfaceFreshnessLine
        testID={failed ? 'bots-roster.partial' : 'bots-roster.unreadable'}
        tone={failed ? 'warning' : 'neutral'}
        reason={t(failed ? 'bots.partial' : 'bots.unreadable')}
        action={failed ? { label: t('common.retry'), onPress: retry } : undefined}
      />
    </View>
  ) : null;

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
        {freshnessLine}
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
      maxHeight={props.maxHeight}
      title={t('bots.title')}
      actions={footerActions}
      summary={
        <View style={styles.summary}>
          {counts.needsYou > 0 ? (
            <StatusDot color={theme.colors.state.warning.foreground} />
          ) : null}
          {summary ? (
            <Text style={styles.summaryText} numberOfLines={1}>
              {summary}
            </Text>
          ) : null}
        </View>
      }
    >
      {offlineHome ? (
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
        style={RAIL_POPOVER_ROSTER_LIST_STYLE}
        keyboardShouldPersistTaps="always"
        testID="bots-roster.list"
      >
        {rows.map((row, index) => {
          const isLast = index === rows.length - 1;
          // A quiet top-level Bot carries its readiness under its row (lab K3-R); busy ones say what they do.
          const readinessServerId = !items[index]!.reportsDepth
            && row.botActivity === 'quiet'
            ? items[index]!.serverId ?? null : null;
          return row.session ? (
            <React.Fragment key={row.sessionKey ?? items[index]!.sessionId}>
            <SessionItem
              rowViewModel={row}
              session={row.session}
              serverId={items[index]!.serverId ?? undefined}
              compact
              embedded
              showTalkAction
              quietWhenOffline
              actionMenuSurface="botsRoster"
              reportsDepth={items[index]!.reportsDepth}
              reportsDisclosure={readSessionLiveManagedSessionCountV1(row.session.managedSessions) > 0
                ? (collapsed[buildSessionListIndexNodeId(items[index]!)] ?? (row.session.metadata?.bot?.kind === 'bot')) ? 'collapsed' : 'expanded'
                : undefined}
              onSetReportsCollapsed={setCollapsed}
              onOpened={close}
            />
            {readinessServerId ? (
              <BotRosterReadiness serverId={readinessServerId} sessionId={row.session.id} separator={!isLast} />
            ) : null}
            {readSessionLiveManagedSessionCountV1(row.session.managedSessions) > 0 && collapsed[buildSessionListIndexNodeId(items[index]!)] === false
              ? <BotRosterReports lead={row.session} item={items[index]!} />
              : null}
            </React.Fragment>
          ) : null;
        })}
        {loading ? (
          <EmptyState
            layout="line"
            testID="bots-roster.loading"
            title={t('bots.loading')}
          />
        ) : null}
      </ScrollView>
      {freshnessLine}
    </RailPopoverRoster>
  );
}

const stylesheet = StyleSheet.create((theme) => ({
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
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
    paddingHorizontal: theme.space.s12,
    paddingVertical: theme.space.s4,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginHorizontal: theme.space.s12,
    backgroundColor: theme.colors.border.default,
  },
  emptyRoot: {
    paddingBottom: theme.space.s12,
  },
}));
