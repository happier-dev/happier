import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HAPPIER_COLLECTION_LIST_METRICS } from '@happier-dev/plugin-ui/presentation';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import {
  CollectionListGroupLabel,
  CollectionNavigationRow,
  CollectionRowOrder,
  CollectionSkeletonRows,
} from '@/components/ui/lists/collection/CollectionList';
import { Text } from '@/components/ui/text/Text';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { WorkflowRunStateMark } from '../presentation/WorkflowLifecycleStatus';
import { describeWorkflowRunState } from '../presentation/workflowLifecyclePresentation';
import { NearViewportWindow } from '@/components/widgets/NearViewportWindow';
import { usePresentedValue } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { WorkStatusRowMark } from '@/components/work/status/WorkStatusRowMark';
import { isWorkStatusNeedsYou } from '@/components/work/status/resolveWorkStatusTone';
import { t, usePreferredLanguage } from '@/text';
import { resolveWorkflowRunRowDetails, type WorkflowRunRowDetails } from '../library/workflowLibraryCells';
import { readWorkflowRunTook } from '../library/WorkflowRunsHome';

import { useServerScopedMachineLabel } from '@/sync/store/hooks';
import type {
  WorkflowRunCollection,
  WorkflowRunCollectionRow,
  WorkflowRunNavigationFacet,
} from '../library/useWorkflowRunCollection';

/**
 * The Runs sidebar and phone list (scene 8 Runs): the one `workflowRun` collection grouped as its Group by says
 * (Date by default), each row the run's name over where it ran, with its time at the end. Only a run that is working,
 * needs you or failed carries a mark (review 10); settled runs stay calm.
 */
export const WorkflowRunsColumnRows = React.memo(
  function WorkflowRunsColumnRows(
    props: Readonly<{
      model: WorkflowRunCollection;
      selectedRunId: string | null;
      testIDPrefix: string;
    }>,
  ) {
    const router = useRouter();
    const language = usePreferredLanguage();
    // A hidden Runs view releases its read; it keeps showing the rows it last presented (a switch never rebuilds a list).
  const model = usePresentedValue(props.model);
    // The Run display owner's Lines and Row details (B1 list review 2), read once for every row.
    const rowDisplay = React.useMemo((): RunRowDisplay => ({ lines: model.display.lines,
        details: resolveWorkflowRunRowDetails(model.display.details), readPluginDetail: model.readPluginDetail }),
    [model.display.details, model.display.lines, model.readPluginDetail]);
    const time = React.useMemo(
      () => new Intl.DateTimeFormat(language, { timeStyle: 'short' }),
      [language],
    );
    const sections = React.useMemo(() => {
      const byGroup = new Map<string, WorkflowRunCollectionRow[]>();
      for (const row of model.rows) {
        if (!model.filter(row)) continue;
        const key = model.groups.groupOf(row);
        const list = byGroup.get(key);
        if (list) list.push(row);
        else byGroup.set(key, [row]);
      }
      return model.groups.axis.flatMap((group) => {
        const rows = byGroup.get(group.key);
        return rows ? [{ key: group.key, title: group.title, rows }] : [];
      });
    }, [model.filter, model.groups, model.rows]);
    if (model.rows.length === 0 && model.runs.status === 'loading')
      return <CollectionSkeletonRows count={3} />;
    if (sections.length === 0) {
      return model.runs.status === 'loaded' ? (
        <EmptyState
          testID={`${props.testIDPrefix}:empty`}
          layout="line"
          title={t('workflows.destination.runsEmpty')}
        />
      ) : null;
    }
    let index = 0;
    return (
      <>
        {sections.map((section, sectionIndex) => (
          <React.Fragment key={section.key}>
            <CollectionListGroupLabel
              testID={`${props.testIDPrefix}:group:${section.key}`}
              title={section.title}
              count={section.rows.length}
              first={sectionIndex === 0}
            />
            {section.rows.map((row, rowIndex) => {
              const at = index++;
              const selected = props.selectedRunId === row.key;
              return (
                <CollectionRowOrder
                  key={row.key}
                  followed={rowIndex < section.rows.length - 1}
                  precedesSelected={
                    section.rows[rowIndex + 1]?.key === props.selectedRunId
                  }
                >
                  <NearViewportWindow
                    id={row.key}
                    testID={`${props.testIDPrefix}:row-window:${row.key}`}
                    pinned={selected}
                    estimatedTop={
                      at * HAPPIER_COLLECTION_LIST_METRICS.rowMinHeight
                    }
                    estimatedHeight={
                      HAPPIER_COLLECTION_LIST_METRICS.rowMinHeight
                    }
                  >
                    <WorkflowRunColumnRow
                      row={row}
                      selected={selected}
                      time={time}
                      display={rowDisplay}
                      testID={`${props.testIDPrefix}:row:${row.key}`}
                      onOpen={() => router.push(row.route as never)}
                    />
                  </NearViewportWindow>
                </CollectionRowOrder>
              );
            })}
          </React.Fragment>
        ))}
      </>
    );
  },
);

const WorkflowRunColumnRow = React.memo(function WorkflowRunColumnRow(
  props: Readonly<{
    row: WorkflowRunCollectionRow;
    selected: boolean;
    time: Intl.DateTimeFormat;
    display: RunRowDisplay;
    testID: string;
    onOpen: () => void;
  }>,
) {
  const { row } = props;
  const { status } = row;
  const queued = status?.state === 'queued' ? describeWorkflowRunState('queued') : null;
  const mark = queued !== null ? (
    <WorkflowRunStateMark presentation={queued} size={ICON_SIZE.xs} testID={`${props.testID}:waiting`} />
  ) : status === null || (status.tone === 'neutral' && status.bucket !== 'working') ? null : (
    <WorkStatusRowMark testIDSuffix={`workflow-run-${row.key}`} status={status} />
  );
  // The start time ends a settled row; a working run's mark speaks instead (its live timer is on its page).
  const when =
    (queued === null && status?.bucket === 'working') || row.createdAt === undefined
      ? null
      : props.time.format(row.createdAt);
  // Lines 1 is the name alone; Lines 2 adds the run's subject (and a plugin's context detail); Lines 3 adds who started
  // it and how long it took when those details are on. The sidebar row has one line under its name, so they share it.
  const { lines, details, readPluginDetail } = props.display;
  const line = lines === 1 ? null : [row.setUpBy, row.subject, readPluginDetail(row, 'context')].filter(Boolean).join(' · ') || null;
  // Lines 3 is its own line under the subject (lab "Lines × details"), as the Runs page list draws it.
  const lineThree = lines === 3 ? [
    details.startedBy ? row.startedBy : null,
    details.took ? readWorkflowRunTook(row) : null,
  ].filter(Boolean).join(' · ') || null : null;
  const pluginMark = readPluginDetail(row, 'mark');
  const stateWord = status?.word ?? row.result;
  return (
    <CollectionNavigationRow
      testID={props.testID}
      title={row.title}
      {...(line ? { subtitle: line } : {})}
      status={
        mark !== null || when !== null || pluginMark !== null ? (
          <View style={styles.end}>
            {mark}
            {pluginMark === null ? null : (
              <Text variant="meta" numberOfLines={1} style={styles.when}>
                {pluginMark}
              </Text>
            )}
            {when === null ? null : (
              <Text variant="meta" numberOfLines={1} style={styles.when}>
                {when}
              </Text>
            )}
          </View>
        ) : undefined
      }
      {...(lineThree === null ? {} : { lines: [{ key: 'line-3', start: lineThree }] })}
      // The row's end is its compact status (the waiting glyph alone, as its neighbours' dots): the state word is
      // spoken with the name, so the time stays whole and the name keeps the row's width (round 16 SHOULD 1).
      accessibilityLabel={[row.title, row.setUpBy, queued?.label ?? stateWord, lineThree].filter(Boolean).join(', ')}
      selected={props.selected}
      onPress={props.onOpen}
    />
  );
});

type RunRowDisplay = Readonly<{
  lines: 1 | 2 | 3;
  details: WorkflowRunRowDetails;
  readPluginDetail: (row: WorkflowRunCollectionRow, slot: 'context' | 'mark') => string | null;
}>;

const styles = StyleSheet.create((theme) => ({
  // The mark and the time share the name's one line, as the Workflows rows' end does at one line.
  end: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    flexShrink: 0,
  },
  // The end's short facts (a plugin's mark, the time) never truncate; the name gives way first.
  when: {
    color: theme.colors.text.tertiary,
    fontVariant: ['tabular-nums'],
    flexShrink: 0,
  },
}));

/**
 * The Runs sidebar beside the Runs table (lab `queue:A:live` navigation column): the table already lists every run, so
 * the column navigates instead of repeating it. "All runs", then one row per Workflow and one per Machine that has runs
 * (Hosts & sandboxes), each narrowing the one run binding the table reads (`selectNavigation`); one row is selected at a
 * time. A row with a run waiting on the person or working carries that run's own Work status mark; counts are runs in
 * the loaded window.
 */
export const WorkflowRunsColumnNavigation = React.memo(function WorkflowRunsColumnNavigation(props: Readonly<{
  model: WorkflowRunCollection;
  testIDPrefix: string;
}>) {
  const model = usePresentedValue(props.model);
  const { selectNavigation } = model;
  const selected = readSelectedNavigation(model.binding.filters);
  const { workflows, machines } = React.useMemo(() => ({
    workflows: groupRunsBy(model.rows, (row) => ({ key: row.workflow.key, title: row.workflow.title })),
    machines: groupRunsBy(model.rows, (row) => row.facts.machineId ? { key: row.facts.machineId, title: null } : null),
  }), [model.rows]);
  if (model.rows.length === 0 && model.runs.status === 'loading') return <CollectionSkeletonRows count={3} />;
  const serverId = model.runs.serverId ?? null;
  return (
    <>
      <CollectionNavigationRow
        testID={`${props.testIDPrefix}:all`}
        title={t('workflows.destination.allRuns')}
        count={model.rows.length > 0 ? model.rows.length : undefined}
        selected={selected === null}
        onPress={() => selectNavigation(null)}
      />
      {workflows.length > 0 ? (
        <CollectionListGroupLabel testID={`${props.testIDPrefix}:group:workflows`} title={t('workflows.title')} count={workflows.length} />
      ) : null}
      {workflows.map((entry, index) => (
        <WorkflowRunsNavigationEntry key={entry.key} entry={entry} title={entry.title ?? ''} facet="workflows"
          index={index} last={index === workflows.length - 1} nextKey={workflows[index + 1]?.key}
          selected={selected} onSelect={selectNavigation} testIDPrefix={`${props.testIDPrefix}:workflow`} />
      ))}
      {machines.length > 0 ? (
        <CollectionListGroupLabel testID={`${props.testIDPrefix}:group:machines`} title={t('workflows.destination.hostsAndSandboxes')} count={machines.length} />
      ) : null}
      {machines.map((entry, index) => (
        <WorkflowRunsMachineNavigationEntry key={entry.key} entry={entry} serverId={serverId}
          index={workflows.length + index} last={index === machines.length - 1} nextKey={machines[index + 1]?.key}
          selected={selected} onSelect={selectNavigation} testIDPrefix={`${props.testIDPrefix}:machine`} />
      ))}
    </>
  );
});

type RunNavigationGroup = { key: string; title: string | null; count: number; mark: WorkflowRunCollectionRow | null; needsYou: boolean };
type RunNavigationSelection = Readonly<{ facet: WorkflowRunNavigationFacet; key: string }> | null;
type RunNavigationEntryProps = Readonly<{
  entry: RunNavigationGroup;
  index: number;
  last: boolean;
  nextKey: string | undefined;
  selected: RunNavigationSelection;
  onSelect: (target: RunNavigationSelection) => void;
  testIDPrefix: string;
}>;

/** One Machine's sidebar row, named by the Machine label owner (an unnamed Machine reads "Machine"). */
const WorkflowRunsMachineNavigationEntry = React.memo(function WorkflowRunsMachineNavigationEntry(
  props: RunNavigationEntryProps & Readonly<{ serverId: string | null }>,
) {
  const { serverId, ...entryProps } = props;
  const name = useServerScopedMachineLabel(serverId, props.entry.key);
  return <WorkflowRunsNavigationEntry {...entryProps} facet="machineId" title={name ?? t('workflows.destination.now.unnamedMachine')} />;
});

const WorkflowRunsNavigationEntry = React.memo(function WorkflowRunsNavigationEntry(
  props: RunNavigationEntryProps & Readonly<{ facet: WorkflowRunNavigationFacet; title: string }>,
) {
  const { entry, facet, selected } = props;
  const isSelected = selected?.facet === facet && selected.key === entry.key;
  const nextSelected = selected?.facet === facet && props.nextKey !== undefined && selected.key === props.nextKey;
  return (
    <CollectionRowOrder followed={!props.last} precedesSelected={nextSelected}>
      <NearViewportWindow id={`${facet}:${entry.key}`} testID={`${props.testIDPrefix}-window:${entry.key}`}
        pinned={isSelected}
        estimatedTop={props.index * HAPPIER_COLLECTION_LIST_METRICS.rowMinHeight}
        estimatedHeight={HAPPIER_COLLECTION_LIST_METRICS.rowMinHeight}>
        <CollectionNavigationRow
          testID={`${props.testIDPrefix}:${entry.key}`}
          title={props.title}
          count={entry.count}
          needsYouStatus={entry.needsYou ? entry.mark?.status ?? null : null}
          {...(entry.mark?.status ? { status: <WorkStatusRowMark testIDSuffix={`workflow-runs-nav-${facet}-${entry.key}`} status={entry.mark.status} /> } : {})}
          selected={isSelected}
          onPress={() => props.onSelect(isSelected ? null : { facet, key: entry.key })}
        />
      </NearViewportWindow>
    </CollectionRowOrder>
  );
});

/**
 * The loaded runs grouped for one sidebar facet, sorted by title (Machines by id; their rows resolve names). A run
 * waiting on the person outranks a working one for the row's mark; settled runs never mark it.
 */
function groupRunsBy(
  rows: readonly WorkflowRunCollectionRow[],
  read: (row: WorkflowRunCollectionRow) => { key: string; title: string | null } | null,
): RunNavigationGroup[] {
  const byKey = new Map<string, RunNavigationGroup>();
  for (const row of rows) {
    const facet = read(row);
    if (facet === null) continue;
    const entry = byKey.get(facet.key) ?? { key: facet.key, title: facet.title, count: 0, mark: null, needsYou: false };
    entry.count += 1;
    const status = row.status;
    const needsYou = status !== null && isWorkStatusNeedsYou(status);
    if (needsYou && !entry.needsYou) { entry.mark = row; entry.needsYou = true; }
    else if (status?.bucket === 'working' && entry.mark === null) entry.mark = row;
    byKey.set(facet.key, entry);
  }
  return [...byKey.values()].sort((a, b) => (a.title ?? a.key).localeCompare(b.title ?? b.key));
}

/** The one sidebar row the binding narrows to, or null for all runs (or a wider toolbar selection). */
function readSelectedNavigation(filters: WorkflowRunCollection['binding']['filters']): RunNavigationSelection {
  for (const facet of ['workflows', 'machineId'] as const) {
    const selection = filters[facet];
    if (selection && selection.include.length === 1 && selection.exclude.length === 0) return { facet, key: selection.include[0]! };
  }
  return null;
}
