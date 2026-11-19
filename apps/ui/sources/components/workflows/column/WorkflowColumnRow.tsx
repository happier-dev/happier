import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { CollectionNavigationRow } from '@/components/ui/lists/collection/CollectionList';
import { StatusWord } from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import {
  readWorkflowLibraryRowFacts,
  readWorkflowLibraryRowMarks,
  type WorkflowLibraryItem,
} from '../library/workflowLibraryCells';
import { WorkflowRunStripView } from '../library/WorkflowRunStripView';
import { WorkflowMarks } from '../presentation/WorkflowMarks';

/**
 * A workflow's sidebar row (scene 8 "Lines × details", Lines 2): navigation only, no switch. Line 1 is the name with
 * what it uses as a tight cluster of marks at the end; line 2 leads with the state word when it speaks (Needs you in
 * amber, Off quiet), then the trigger sentence, with the run strip at the end. The facts come from the one row
 * reading the library page draws (`readWorkflowLibraryRowFacts`).
 */
export const WorkflowColumnRow = React.memo(function WorkflowColumnRow(
  props: Readonly<{
    row: WorkflowLibraryItem;
    title: string;
    /** Line 2 when the row has no trigger sentence of its own (why a shared workflow can't be read). */
    fallbackLine?: string | null;
    href?: string;
    selected: boolean;
    dimmed?: boolean;
    testID: string;
    onPress: () => void;
  }>,
) {
  const facts = React.useMemo(() => readWorkflowLibraryRowFacts(props.row), [props.row]);
  const marks = readWorkflowLibraryRowMarks(facts, props.row);
  const line =
    facts.state === 'unavailable'
      ? (props.fallbackLine ?? facts.triggerLine)
      : (facts.triggerLine ?? props.fallbackLine ?? null);
  const stateWord =
    facts.state === 'needsYou'
      ? t('workflows.destination.sections.needsYou')
      : facts.state === 'running'
        ? t('workflows.destination.sections.running')
        : facts.state === 'off'
        ? t('workflows.destination.off')
        : facts.state === 'unavailable'
          ? t('common.unavailable')
          : null;
  const end =
    marks.length > 0 || facts.strip !== null ? (
      <View style={styles.end}>
        <WorkflowMarks layout="cluster" marks={marks} />
        {facts.strip === null ? null : (
          <WorkflowRunStripView strip={facts.strip} />
        )}
      </View>
    ) : undefined;
  const lead =
    stateWord === null ? undefined : (
      <Text variant="meta" numberOfLines={1}>
        {facts.state === 'needsYou' ? (
          <StatusWord variant="attention" label={stateWord} />
        ) : (
          <Text style={styles.quiet}>{stateWord}</Text>
        )}
        {/* The row's mark slot keeps its own gap after the dot. */}{line ? <Text style={styles.quiet}>{' ·'}</Text> : null}
      </Text>
    );
  return (
    <CollectionNavigationRow
      {...(props.href === undefined ? {} : { href: props.href })}
      testID={props.testID}
      title={props.title}
      {...(line ? { subtitle: line } : {})}
      {...(lead === undefined ? {} : { subtitleLeading: lead })}
      {...(end === undefined ? {} : { status: end })}
      accessibilityLabel={
        stateWord === null ? props.title : `${props.title}, ${stateWord}`
      }
      selected={props.selected}
      needsYou={facts.state === 'needsYou'}
      {...(props.dimmed ? { dimmed: true } : {})}
      onPress={props.onPress}
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  // The row's end: the marks level with the name, the strip level with line 2 (lab `.lw-sr`).
  end: {
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: theme.space.s4,
    paddingTop: theme.space.s2,
  },
  quiet: {
    color: theme.colors.text.tertiary,
  },
}));
