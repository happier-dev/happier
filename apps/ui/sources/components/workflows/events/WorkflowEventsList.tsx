import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HAPPIER_COLLECTION_LIST_METRICS } from '@happier-dev/plugin-ui/presentation';

import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Icon } from '@/components/ui/icons/Icon';
import {
  CollectionNavigationRow,
  CollectionSkeletonRows,
  collectionListStyles,
} from '@/components/ui/lists/collection/CollectionList';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { InlineStatus } from '@/components/ui/status/InlineStatus';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { NearViewportWindow } from '@/components/widgets/NearViewportWindow';
import { useSessionListRuntimeDeadlineNowMs } from '@/hooks/session/sessionListRuntimeClock';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useWorkflowActivityFeed } from '@/sync/domains/workflows/useWorkflowActivityFeed';
import type { WorkflowActivityProjection } from '@/sync/engine/workflows/workflowActivityProjection';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import {
  formatRelativeTimeShort,
  readRelativeTimeShortRefreshAtMs,
} from '@/utils/time/formatShortRelativeTime';
import { t } from '@/text';

import {
  matchesWorkflowEventFilter,
  orderWorkflowEventFilters,
  type WorkflowEventFilter,
} from './workflowEventFacts';
import {
  useWorkflowEventFact,
  useWorkflowEventPresentation,
} from './useWorkflowEventPresentation';

export type WorkflowEventsFeed = ReturnType<typeof useWorkflowActivityFeed>;

/**
 * The one Events feed for the mounted Account (D11): the Workflows column's Events view, the main pane's event
 * detail and the editor's Live events companion all borrow the same source and projection while presented.
 */
export function useWorkflowEventsFeed(
  active: boolean,
): Readonly<{ feed: WorkflowEventsFeed; scope: ServerAccountScope | null }> {
  const lifetime = useActiveServerAccountScopeLifetime();
  const feed = useWorkflowActivityFeed({ lifetime, active });
  return { feed, scope: lifetime?.scope ?? null };
}

/** Whether the feed is listening, and since when: the truth behind an empty list (glance tier). */
export const WorkflowEventsListening = React.memo(
  function WorkflowEventsListening(
    props: Readonly<{
      status: WorkflowEventsFeed['status'];
      listeningSince: number | null;
      historyError: unknown;
      onRetry: () => void;
      testID: string;
    }>,
  ) {
    if (props.status === 'failed') {
      return (
        <SurfaceFreshnessLine
          testID={`${props.testID}:failed`}
          tone="warning"
          reason={t('workflows.events.failed')}
          action={{ label: t('workflows.retry'), onPress: props.onRetry }}
        />
      );
    }
    if (props.historyError !== null) {
      return (
        <SurfaceFreshnessLine
          testID={`${props.testID}:history-failed`}
          tone="warning"
          reason={t('workflows.events.historyFailed')}
          action={{ label: t('workflows.retry'), onPress: props.onRetry }}
        />
      );
    }
    const label =
      props.status === 'offline'
        ? t('workflows.events.paused')
        : props.status === 'live' && props.listeningSince !== null
          ? t('workflows.events.listeningSince', {
              time: formatAsOfTime(props.listeningSince),
            })
          : t('workflows.events.connecting');
    const tone =
      props.status === 'offline'
        ? 'warning'
        : props.status === 'live'
          ? 'success'
          : 'muted';
    return (
      <View testID={`${props.testID}:${props.status}`} style={styles.listening}>
        <InlineStatus
          tone={tone}
          label={label}
          pulsing={props.status === 'connecting'}
        />
      </View>
    );
  },
);

/** Which kinds show, as whole pills; the ones that do not fit move behind More, never cut at the edge. */
export const WorkflowEventsFilters = React.memo(function WorkflowEventsFilters(
  props: Readonly<{
    projection: WorkflowActivityProjection;
    keys: readonly string[];
    value: WorkflowEventFilter;
    onChange: (filter: WorkflowEventFilter) => void;
    testID: string;
  }>,
) {
  const { keys, projection } = props;
  const counts = React.useMemo(() => {
    const next: Record<WorkflowEventFilter, number> = {
      all: keys.length,
      session: 0,
      machine: 0,
      run: 0,
    };
    for (const key of keys) {
      const kind = projection.getRow(key)?.kind;
      if (kind !== undefined) next[kind] += 1;
    }
    return next;
  }, [keys, projection]);
  const tabs = React.useMemo(
    () =>
      orderWorkflowEventFilters(counts)
        .map((id) => ({
          id,
          label: t(`workflows.events.filters.${id}`),
          ...(id === 'all' || counts[id] === 0
            ? {}
            : { count: String(counts[id]) }),
        })),
    [counts],
  );
  return (
    <View style={styles.filters}>
      <SegmentedTabBar<WorkflowEventFilter>
        testIDPrefix={props.testID}
        accessibilityLabel={t('workflows.events.filtersAccessibility')}
        presentation="pills"
        compact
        segmentSizing="content"
        tabs={tabs}
        activeTabId={props.value}
        onSelectTab={props.onChange}
        overflow={{
          label: t('workflows.events.more'),
          testID: `${props.testID}:more`,
        }}
      />
    </View>
  );
});

/**
 * The feed's rows (scan tier): the shipped column row anatomy — the fact's mark, what happened, what it is about,
 * and how long ago, or the amber mark while it needs you. Each row reads its own fact; only rows near the
 * viewport are built.
 */
export const WorkflowEventsRows = React.memo(function WorkflowEventsRows(
  props: Readonly<{
    feed: WorkflowEventsFeed;
    scope: ServerAccountScope | null;
    filter: WorkflowEventFilter;
    selectedKey: string | null;
    onSelect: (key: string) => void;
    surface: 'plane' | 'page';
    active: boolean;
    testID: string;
    /** The companion expands a row in place; the column opens it in the main pane. */
    renderExpanded?: (key: string) => React.ReactNode;
  }>,
) {
  const { feed, filter } = props;
  const keys = React.useMemo(
    () =>
      filter === 'all'
        ? feed.keys
        : feed.keys.filter((key) => {
            const fact = feed.projection.getRow(key);
            return (
              fact !== undefined && matchesWorkflowEventFilter(fact, filter)
            );
          }),
    [feed.keys, feed.projection, filter],
  );
  if (keys.length === 0) {
    // Listening with the retained page not read yet is still loading: "nothing yet" is said only once the
    // feed has its first page (DESIGN-ACCEPT-1 D9: a remounted feed read as empty while its page was in flight).
    if (
      feed.status === 'connecting' ||
      (feed.status === 'live' && feed.retained === null) ||
      (feed.listeningSince === null &&
        feed.status !== 'failed' &&
        feed.status !== 'offline')
    ) {
      return <CollectionSkeletonRows count={5} />;
    }
    // A failed or paused feed with nothing held: the listening line already says why, with its Retry (one cause, one line).
    if (feed.keys.length === 0 && (feed.status === 'failed' || feed.status === 'offline')) return null;
    return (
      <View style={collectionListStyles.stateLine}>
        <EmptyState
          testID={`${props.testID}:empty`}
          layout="line"
          title={
            feed.keys.length === 0
              ? t('workflows.events.empty')
              : t('workflows.events.emptyFiltered')
          }
        />
      </View>
    );
  }
  const rowHeight = HAPPIER_COLLECTION_LIST_METRICS.rowMinHeight;
  return (
    <>
      {keys.map((key, index) => (
        <NearViewportWindow
          key={key}
          id={key}
          testID={`${props.testID}:window:${key}`}
          pinned={key === props.selectedKey}
          estimatedTop={index * rowHeight}
          estimatedHeight={rowHeight}
        >
          <WorkflowEventRow
            projection={feed.projection}
            eventKey={key}
            scope={props.scope}
            surface={props.surface}
            selected={key === props.selectedKey}
            onSelect={props.onSelect}
            active={props.active}
            testID={props.testID}
          />
          {key === props.selectedKey && props.renderExpanded
            ? props.renderExpanded(key)
            : null}
        </NearViewportWindow>
      ))}
    </>
  );
});

const WorkflowEventRow = React.memo(function WorkflowEventRow(
  props: Readonly<{
    projection: WorkflowActivityProjection;
    eventKey: string;
    scope: ServerAccountScope | null;
    surface: 'plane' | 'page';
    selected: boolean;
    onSelect: (key: string) => void;
    active: boolean;
    testID: string;
  }>,
) {
  const fact = useWorkflowEventFact(props.projection, props.eventKey);
  const presentation = useWorkflowEventPresentation(fact, props.scope, undefined, props.active);
  const occurredAt = fact?.occurredAt ?? null;
  const readNextRefresh = React.useCallback(
    (nowMs: number) =>
      occurredAt === null
        ? null
        : readRelativeTimeShortRefreshAtMs(occurredAt, nowMs),
    [occurredAt],
  );
  const nowMs = useSessionListRuntimeDeadlineNowMs(
    readNextRefresh,
    props.active && occurredAt !== null,
  );
  const { onSelect, eventKey } = props;
  const onPress = React.useCallback(
    () => onSelect(eventKey),
    [onSelect, eventKey],
  );
  if (presentation === null || occurredAt === null) return null;
  return (
    <CollectionNavigationRow
      testID={`${props.testID}:row:${props.eventKey}`}
      surface={props.surface}
      title={presentation.title}
      {...(presentation.subtitle === null
        ? {}
        : { subtitle: presentation.subtitle })}
      icon={<Icon name={presentation.glyph} />}
      detail={formatRelativeTimeShort(occurredAt, nowMs)}
      needsYou={presentation.needsYou}
      {...(presentation.needsYou
        ? {
            status: (
              <InlineStatus
                tone="attention"
                label={t('workflows.destination.sections.needsYou')}
              />
            ),
          }
        : {})}
      selected={props.selected}
      onPress={onPress}
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  listening: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
    flexShrink: 1,
  },
  filters: { minWidth: 0 },
}));
