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
import { WORK_STATUS_PILL_VARIANT } from '@/components/work/status/resolveWorkStatusTone';
import { t, usePreferredLanguage } from '@/text';
import { WorkflowRunsViewGroupBy } from './WorkflowsViewMenu';
import { resolveWorkflowRunRowDetails } from './workflowLibraryCells';
import { CollectionColumnsMenuButton, collectionColumnsMenuColumns } from '@/components/ui/lists/collection/CollectionColumnsMenu';

import {
  useWorkflowRunCollection,
  useWorkflowRunCollectionHeader,
  type WorkflowRunCollection,
  type WorkflowRunCollectionRow,
} from './useWorkflowRunCollection';

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
  const { status, result } = props.row;
  const label = status?.word ?? result;
  if (label === null) return null;
  const variant = WORK_STATUS_PILL_VARIANT[status?.tone ?? 'neutral'];
  return (
    <Text testID={props.testID} variant="meta" numberOfLines={1} style={variant === 'neutral' ? styles.result : undefined}>
      {variant === 'neutral' ? label : <StatusWord variant={variant} label={label} />}
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
  const model = useWorkflowRunCollection(focused);
  const header = useWorkflowRunCollectionHeader(
    model,
    'workflow-runs-space',
    'section',
  );
  return (
    <WorkflowRunsPage model={model} head={(columnsMenu) => <>
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
        {columnsMenu}
      </View>
      <View style={styles.spaceStrip}>{header.strip}</View>
      {header.conditionRow ? (
        <View style={styles.spaceStrip}>{header.conditionRow}</View>
      ) : null}
      {header.overlays}
    </>} />
  );
}

/**
 * The Runs page list: the one Run collection as a page list, under the page's own head (the wide page's header and
 * toolbar) or a phone's main-screen head, which owns the title, search and View. A phone's Runs are a page, so they
 * take the page list's rows and group labels, as the Workflows index does (UI refinements 21:44Z, item 4).
 */
export function WorkflowRunsPage(props: Readonly<{
  model: WorkflowRunCollection;
  /** The wide page's head; it places the table's View menu (Group by, then Columns) in its toolbar. */
  head?: (columnsMenu: React.ReactNode) => React.ReactNode;
}>): React.ReactElement {
  const { model } = props;
  const { lines } = model.display;
  const runDetails = React.useMemo(() => resolveWorkflowRunRowDetails(model.display.details), [model.display.details]);
  const { readPluginDetail } = model;
  const router = useRouter();
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
        // A list row (a phone, a narrow page) reads the Run Lines and Row details (B1 list review 2): Lines 2 adds the
        // subject; Lines 3 adds who started it and how long it took on their own line. The table names them Columns.
        byline: lines === 1 ? undefined : (row) => [row.subject, readPluginDetail(row, 'context')].filter(Boolean).join(' · ') || null,
        description: lines === 3 ? (row) => [
          runDetails.startedBy ? row.startedBy : null,
          runDetails.took ? readWorkflowRunTook(row) : null,
        ].filter(Boolean).join(' · ') || null : undefined,
        bylineLead: (row) => {
          const { status } = row;
          return status === null || (status.tone === 'neutral' && status.bucket !== 'working')
            ? null : <WorkflowRunResult row={row} />;
        },
        listFact: (row) =>
          row.createdAt === undefined ? null : time.format(row.createdAt),
        fields,
        accessibilityLabel: (row) => {
          const label = row.status?.word ?? row.result;
          return label ? `${row.title}, ${label}` : row.title;
        },
        testID: (row) => `workflow-runs:row:${row.key}`,
        columnTitles: { title: t('workflows.destination.columns.run') },
      };
    }, [language, lines, model.extensions.columns, readPluginDetail, runDetails]);

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

  // The table chooses its Columns through the one Collection Columns owner, so a contributed default-hidden column can
  // be turned on (B1 list review 2); the View menu leads with Group by.
  const [fittedColumns, setFittedColumns] = React.useState<readonly string[] | null>(null);
  const columns = React.useMemo(() => ({ collectionId: WORKFLOW_RUNS_COLLECTION_ID, onColumnsFit: setFittedColumns }), []);
  const menuColumns = React.useMemo(() => collectionColumnsMenuColumns(
    { id: 'title', title: t('workflows.destination.columns.run') }, anatomy.fields ?? [],
  ), [anatomy.fields]);
  const columnsMenu = props.head ? <CollectionColumnsMenuButton
    testID="workflow-runs:view"
    trigger="labelled"
    collectionId={WORKFLOW_RUNS_COLLECTION_ID}
    columns={menuColumns}
    fittedIds={fittedColumns}
    label={t('workflows.destination.columns.view')}
    beforeColumns={<WorkflowRunsViewGroupBy groupBy={model.display.groupBy} onGroupBy={model.display.setGroupBy} testID="workflow-runs:view" />}
  /> : null;
  return (
    <ItemList pageColumn="wide">
      <CoreCollectionScope renderPageScroller={passThroughPageScroller}>
        <PageContentColumn>
          {props.head?.(columnsMenu)}
          <Collection<WorkflowRunCollectionRow>
            testID="workflow-runs:collection"
            model={collection}
            anatomy={anatomy}
            accessibilityLabel={t('workflows.tabs.runs')}
            presentation="table"
            detail="none"
            scroll="page-virtualized"
            columns={columns}
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

/** The Runs table's one stable Collection id: its Columns choice is kept under it. */
const WORKFLOW_RUNS_COLLECTION_ID = 'workflows.runs';

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
