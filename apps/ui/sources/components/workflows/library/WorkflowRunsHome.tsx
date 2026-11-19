import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
  HostCollection as Collection,
  useHappierCollection,
  type CollectionAnatomy,
  type CollectionField,
} from '@happier-dev/plugin-ui';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';

import {
  useIsFocused,
  useRouter,
} from '@/components/appShell/workspace/destinationRoute';
import { formatElapsedDuration } from '@/components/machines/durationWords';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageContentColumn } from '@/components/ui/lists/PageContentColumn';
import { StatusWord } from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { readWorkflowRunWorkStatusFacts } from '@/components/work/status/workflowWorkStatusFacts';
import { t, usePreferredLanguage } from '@/text';

import {
  useWorkflowRunCollection,
  useWorkflowRunCollectionHeader,
  type WorkflowRunCollectionRow,
} from './useWorkflowRunCollection';

/** How a run's result speaks (scene 8 Runs): amber when it needs you, danger when it failed, quiet otherwise. */
export function readWorkflowRunResultTone(
  row: WorkflowRunCollectionRow,
): 'attention' | 'danger' | 'working' | 'quiet' {
  const summary = row.run.summary;
  if (summary === null) return 'quiet';
  const status = resolveWorkStatusTone({
    kind: 'workflow_run',
    facts: readWorkflowRunWorkStatusFacts(summary),
  });
  if (status.tone === 'danger') return 'danger';
  if (status.bucket === 'needs_you') return 'attention';
  return status.bucket === 'working' ? 'working' : 'quiet';
}

/** How long a finished run took; a run still going has no "took" yet. */
export function readWorkflowRunTook(
  row: WorkflowRunCollectionRow,
): string | null {
  const summary = row.run.summary;
  if (summary?.finishedAt == null) return null;
  const ms = Date.parse(summary.finishedAt) - Date.parse(summary.createdAt);
  return Number.isFinite(ms) && ms >= 0 ? formatElapsedDuration(ms) : null;
}

/** The Result cell owns the run's state: glyph and word, coloured only for needs you and failed (review 10). */
export const WorkflowRunResult = React.memo(function WorkflowRunResult(
  props: Readonly<{ row: WorkflowRunCollectionRow; testID?: string }>,
) {
  const tone = readWorkflowRunResultTone(props.row);
  const label = tone === 'attention' ? t('workflows.destination.sections.needsYou') : props.row.result;
  if (label === null) return null;
  // The word at the cells' own size: ink for a settled run, amber or danger only when it speaks.
  return (
    <Text testID={props.testID} variant="meta" numberOfLines={1} style={tone === 'quiet' || tone === 'working' ? styles.result : undefined}>
      {tone === 'attention' || tone === 'danger' ? <StatusWord variant={tone} label={label} /> : label}
    </Text>
  );
});

const readKey = (row: WorkflowRunCollectionRow) => row.key;

/**
 * Runs beside the Workflows column (scene 8 Runs, D2): every run as one table grouped by Date, Project or Workflow,
 * with the run spaces, search and filters of the one `workflowRun` owner the sidebar reads too. No sections, pins or
 * cards: runs are history.
 */
export function WorkflowRunsHome(): React.ReactElement {
  const focused = useIsFocused();
  const router = useRouter();
  const model = useWorkflowRunCollection(focused);
  const header = useWorkflowRunCollectionHeader(
    model,
    'workflow-runs-space',
    'section',
  );
  const language = usePreferredLanguage();
  const open = React.useCallback(
    (key: string | null) => {
      const row = model.rows.find(candidate => candidate.key === key);
      if (row) router.push(row.route as never);
    },
    [router, model.rows],
  );
  const collection = useHappierCollection<WorkflowRunCollectionRow>({
    items: model.rows,
    keyOf: readKey,
    groups: model.groups,
    filter: model.filter,
    window: model.window,
    openKey: null,
    onOpenChange: open,
  });
  const anatomy =
    React.useMemo((): CollectionAnatomy<WorkflowRunCollectionRow> => {
      const time = new Intl.DateTimeFormat(language, { timeStyle: 'short' });
      const fields: CollectionField<WorkflowRunCollectionRow>[] = [
        {
          key: 'startedBy',
          title: t('workflows.destination.display.startedBy'),
          minWidth: 120,
          maxWidth: 200,
          priority: 3,
          render: (row) => row.startedBy,
        },
        {
          key: 'started',
          title: t('workflows.destination.columns.started'),
          minWidth: 72,
          priority: 4,
          render: (row) =>
            row.createdAt === undefined ? null : time.format(row.createdAt),
        },
        {
          key: 'took',
          title: t('workflows.destination.columns.took'),
          minWidth: 64,
          priority: 2,
          align: 'end',
          render: readWorkflowRunTook,
        },
        ...model.extensions.columns,
        {
          key: 'result',
          title: t('workflows.destination.display.result'),
          minWidth: 140,
          maxWidth: 220,
          priority: 5,
          render: (row) => (
            <WorkflowRunResult
              row={row}
              testID={`workflow-runs:row:${row.key}:result`}
            />
          ),
        },
      ];
      return {
        glyph: () => null,
        loadingGlyph: false,
        title: (row) => row.title,
        byline: (row) => row.startedBy,
        bylineLead: (row) =>
          readWorkflowRunResultTone(row) === 'quiet' ? null : (
            <WorkflowRunResult row={row} />
          ),
        listFact: (row) =>
          row.createdAt === undefined ? null : time.format(row.createdAt),
        fields,
        accessibilityLabel: (row) =>
          row.result ? `${row.title}, ${row.result}` : row.title,
        testID: (row) => `workflow-runs:row:${row.key}`,
        columnTitles: { title: t('workflows.destination.columns.run') },
      };
    }, [language, model.extensions.columns]);

  const failed = model.runs.status === 'failed' && model.rows.length === 0;
  const empty = failed ? (
    <SurfaceStateCard
      testID="workflow-runs:failed"
      size="line"
      kind="error"
      title={t('workflows.destination.history.loadFailedTitle')}
      reason={t('workflows.destination.history.loadFailedBody')}
      accessibilitySemantics="alert"
    />
  ) : model.binding.searchQuery.trim().length > 0 ? (
    <EmptyState
      testID="workflow-runs:noMatch"
      layout="inline"
      iconName="magnifying-glass"
      title={t('workflows.destination.noMatch', {
        query: model.binding.searchQuery.trim(),
      })}
    />
  ) : model.runs.status === 'loaded' ? (
    <EmptyState
      testID="workflow-runs:empty"
      layout="line"
      title={t('workflows.destination.runsEmpty')}
    />
  ) : null;

  return (
    <ItemList pageColumn="wide">
      <CoreCollectionScope renderPageScroller={passThroughPageScroller}>
        <PageContentColumn>
          <PageHeader
            testID="workflow-runs:header"
            title={t('workflows.tabs.runs')}
            description={t('workflows.destination.history.description')}
          />
          {/* Scene 8's one toolbar: the run space and its search lead, the filters end the line. */}
          <View testID="workflow-runs:scope-line" style={styles.controlLine}>
            {header.titleControl}
            <CompactSearchField
              testID="workflow-runs:search"
              accessibilityLabel={t('workflows.destination.display.searchRuns')}
              placeholder={t('workflows.destination.display.searchRuns')}
              value={model.binding.searchQuery}
              onChangeText={model.setSearchQuery}
              style={styles.search}
            />
            <View style={styles.grow} />
            {header.filterButton}
          </View>
          <View style={styles.spaceStrip}>{header.strip}</View>
          {header.conditionRow ? (
            <View style={styles.spaceStrip}>{header.conditionRow}</View>
          ) : null}
          {header.overlays}
          <Collection<WorkflowRunCollectionRow>
            testID="workflow-runs:collection"
            model={collection}
            anatomy={anatomy}
            accessibilityLabel={t('workflows.tabs.runs')}
            presentation="table"
            detail="none"
            scroll="page-virtualized"
            minListWidth={RUNS_MIN_WIDTH_PX}
            minDetailWidth={RUNS_MIN_WIDTH_PX}
            preferredListRatio={1}
            empty={empty}
          />
        </PageContentColumn>
      </CoreCollectionScope>
    </ItemList>
  );
}

/** The narrowest readable run row at normal text size (the library page's own floor). */
const RUNS_MIN_WIDTH_PX = 320;

const passThroughPageScroller = (children: React.ReactNode) => children;

const styles = StyleSheet.create((theme) => ({
  result: {
    color: theme.colors.text.secondary,
  },
  controlLine: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.space.s8,
    paddingTop: HAPPIER_PAGE_METRICS.sectionHeaderGapPx,
    paddingHorizontal: HAPPIER_PAGE_METRICS.sheetInsetPx,
  },
  spaceStrip: {
    paddingHorizontal: HAPPIER_PAGE_METRICS.sheetInsetPx,
    paddingTop: theme.space.s8,
  },
  grow: {
    flexGrow: 1,
  },
  search: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 160,
    maxWidth: 280,
  },
}));
