import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { buildSessionListFilterHomeOptions } from '@/components/sessions/shell/search/useSessionListViewFilterController';
import {
  buildSessionListFilterQueryHomes,
  resolveSessionListViewContextDefaults,
} from '@/components/sessions/shell/search/sessionListViewFilters';
import { SessionItem } from '@/components/sessions/shell/SessionItem';
import {
  buildSessionListRowViewModel,
  resolveSessionListRowViewModelAdjacency,
  type SessionListRowViewModel,
} from '@/components/sessions/shell/sessionListRowViewModels';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Icon } from '@/components/ui/icons/Icon';
import { ActionListSection } from '@/components/ui/lists/ActionListSection';
import { MENU_ROW_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import {
  useSessionListRelativeNowMs,
  useSessionListRuntimeNowMs,
} from '@/hooks/session/sessionListRuntimeClock';
import { useSessionListSelectionState } from '@/hooks/session/useSessionListSelectionState';
import { useVisibleSessionListPaneState } from '@/hooks/session/useVisibleSessionListPaneState';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import {
  isUrgentSessionListAttentionState,
  mapSessionAwarenessToListAttentionState,
} from '@/sync/domains/session/listing/deriveSessionListActivity';
import { useSessionListQueryHomeSupportByServerId } from '@/sync/domains/session/listing/useSessionListQuerySourceState';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { useSessionListRowRenderablesForItems } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { AskHappierMark, AskHappierOfferCard } from './AskHappierOfferCard';
import {
  useAskHappierOfferChoices,
  useAskHappierOfferVisible,
  useAskHappierOpener,
} from './useAskHappierOffer';
import { BOTS_GLYPH } from './botsGlyph';
import { openNewBotDraft } from './newBotDraft';

type SessionIndexItem = Extract<SessionListIndexItem, { type: 'session' }>;

const NO_REACHABLE_DISPLAY = new Map();
const NO_PINNED_KEYS: ReadonlySet<string> = new Set();
const NO_TAGS: Record<string, string[]> = {};
/** The header and the New bot / Ask Happier rows beneath the roster. */
const CHROME_HEIGHT_PX = 150;

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
    const primary = row.sessionStatus?.awareness.operational.primary;
    if (!primary) continue;
    const state = mapSessionAwarenessToListAttentionState(primary);
    if (isUrgentSessionListAttentionState(state)) needsYou += 1;
    else if (state === 'thinking') working += 1;
  }
  return { needsYou, working };
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
  const queryHomes = useBotsRosterQueryHomes();
  const pane = useVisibleSessionListPaneState('all', {
    botsRoster: true,
    queryHomes,
    sessionListSurfaceDataActive: true,
  });
  const items = React.useMemo(
    () =>
      (pane.visibleSessionListIndex ?? []).filter(
        (item): item is SessionIndexItem => item.type === 'session',
      ),
    [pane.visibleSessionListIndex],
  );
  const renderables = useSessionListRowRenderablesForItems(items);
  const relativeNowMs = useSessionListRelativeNowMs(true);
  const runtimeNowMs = useSessionListRuntimeNowMs(true);
  const rows = React.useMemo(
    () =>
      items.map((item, index) =>
        buildSessionListRowViewModel({
          item,
          adjacency: resolveSessionListRowViewModelAdjacency(items, index),
          unscopedSelectionIsUnique: false,
          reachableSessionDisplayById: NO_REACHABLE_DISPLAY,
          rowRenderableByKey: renderables,
          relativeNowMs,
          runtimeNowMs,
          workingTextMode: 'static',
          identityDisplay: 'avatar',
          hasMultipleMachines: false,
          pinnedSessionKeys: NO_PINNED_KEYS,
          sessionTags: NO_TAGS,
          selectedSessionId: null,
          showServerBadge: false,
          showPinnedServerBadge: false,
        }),
      ),
    [items, relativeNowMs, renderables, runtimeNowMs],
  );
  const counts = React.useMemo(() => readRosterCounts(rows), [rows]);

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
  const { close } = props;
  const newBot = React.useCallback(() => {
    close();
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (lifetime)
      fireAndForget(openNewBotDraft(lifetime), { tag: 'BotsRoster.newBot' });
  }, [close]);
  const askHappier = React.useCallback(() => {
    close();
    openAskHappier();
  }, [close, openAskHappier]);
  const startOffer = React.useCallback(() => {
    close();
    offer.start();
  }, [close, offer]);
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

  return (
    <View testID="bots-roster">
      <View style={styles.header}>
        <Text style={styles.title} accessibilityRole="header">
          {t('bots.title')}
        </Text>
        <View style={styles.summary}>
          {counts.needsYou > 0 ? <View style={styles.attentionDot} /> : null}
          <Text style={styles.summaryText} numberOfLines={1}>
            {[
              counts.needsYou > 0
                ? t('bots.roster.needsYou', { count: counts.needsYou })
                : null,
              counts.working > 0
                ? t('bots.roster.working', { count: counts.working })
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        </View>
      </View>
      {offlineHomeLabel ? (
        <View style={styles.line}>
          <SurfaceFreshnessLine
            testID="bots-roster.offline"
            reason={t('bots.offline', { home: offlineHomeLabel })}
          />
        </View>
      ) : null}
      <ScrollView
        style={{ maxHeight: Math.max(160, props.maxHeight - CHROME_HEIGHT_PX) }}
        keyboardShouldPersistTaps="always"
        testID="bots-roster.list"
      >
        {rows.map((row, index) =>
          row.session ? (
            <SessionItem
              key={row.sessionKey ?? items[index]!.sessionId}
              rowViewModel={row}
              session={row.session}
              serverId={items[index]!.serverId ?? undefined}
              compact
              embedded
              embeddedIsLast={index === rows.length - 1}
              showTalkAction
              onOpened={close}
            />
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
      <View style={styles.divider} />
      <ActionListSection style={styles.actions} actions={footerActions} />
    </View>
  );
}

const stylesheet = StyleSheet.create((theme) => ({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
  },
  title: {
    ...Typography.default('semiBold'),
    fontSize: 13,
    lineHeight: 18,
    color: theme.colors.text.primary,
  },
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 1,
  },
  attentionDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.state.warning.foreground,
  },
  summaryText: {
    ...Typography.default(),
    fontSize: 12,
    lineHeight: 16,
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
  hint: {
    ...Typography.default(),
    fontSize: 12,
    lineHeight: 16,
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
  actions: {
    paddingTop: 4,
    paddingBottom: 4,
  },
  emptyRoot: {
    paddingBottom: 12,
  },
}));
