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
  const line = row.subject;
  const stateWord = status?.word ?? row.result;
  return (
    <CollectionNavigationRow
      testID={props.testID}
      title={row.title}
      {...(line ? { subtitle: line } : {})}
      status={
        mark !== null || when !== null ? (
          <View style={styles.end}>
            {mark}
            {when === null ? null : (
              <Text variant="meta" numberOfLines={1} style={styles.when}>
                {when}
              </Text>
            )}
          </View>
        ) : undefined
      }
      accessibilityLabel={stateWord ? `${row.title}, ${stateWord}` : row.title}
      selected={props.selected}
      onPress={props.onOpen}
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  end: {
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: theme.space.s4,
  },
  when: {
    color: theme.colors.text.tertiary,
    fontVariant: ['tabular-nums'],
  },
}));
