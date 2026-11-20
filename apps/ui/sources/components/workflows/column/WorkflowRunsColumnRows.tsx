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
import { NearViewportWindow } from '@/components/widgets/NearViewportWindow';
import { usePresentedValue } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { WorkStatusRowMark } from '@/components/work/status/WorkStatusRowMark';
import { t, usePreferredLanguage } from '@/text';
import { resolveWorkflowRunRowDetails, type WorkflowRunRowDetails } from '../library/workflowLibraryCells';
import { readWorkflowRunTook } from '../library/WorkflowRunsHome';

import type {
  WorkflowRunCollection,
  WorkflowRunCollectionRow,
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
  const mark = status === null || (status.tone === 'neutral' && status.bucket !== 'working') ? null : (
    <WorkStatusRowMark testIDSuffix={`workflow-run-${row.key}`} status={status} />
  );
  // The start time ends a settled row; a working run's mark speaks instead (its live timer is on its page).
  const when =
    status?.bucket === 'working' || row.createdAt === undefined
      ? null
      : props.time.format(row.createdAt);
  // Lines 1 is the name alone; Lines 2 adds the run's subject (and a plugin's context detail); Lines 3 adds who started
  // it and how long it took when those details are on. The sidebar row has one line under its name, so they share it.
  const { lines, details, readPluginDetail } = props.display;
  const line = lines === 1 ? null : [row.subject, readPluginDetail(row, 'context')].filter(Boolean).join(' · ') || null;
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
      accessibilityLabel={[row.title, stateWord, lineThree].filter(Boolean).join(', ')}
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
  },
  when: {
    color: theme.colors.text.tertiary,
    fontVariant: ['tabular-nums'],
  },
}));
