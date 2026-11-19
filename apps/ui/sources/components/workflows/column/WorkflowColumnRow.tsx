import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { CollectionNavigationRow } from '@/components/ui/lists/collection/CollectionList';
import { StatusWord } from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import { formatRelativeTimeShort } from '@/utils/time/formatShortRelativeTime';
import { t } from '@/text';

import {
  readWorkflowLibraryRowFacts,
  readWorkflowLibraryRowMarks,
  resolveWorkflowRowDetails,
  type WorkflowLibraryItem,
  type WorkflowRowDetails,
} from '../library/workflowLibraryCells';
import { WorkflowRunStripView } from '../library/WorkflowRunStripView';
import { WorkflowMarks } from '../presentation/WorkflowMarks';
import { formatNextScheduledRun } from '../triggers/formatTriggerSummary';

/** The sidebar's Lines and Row details, from the one display owner (scene 8 View menu). */
export type WorkflowColumnRowDisplay = Readonly<{ lines: 1 | 2 | 3; details: WorkflowRowDetails }>;
const DEFAULT_DISPLAY: WorkflowColumnRowDisplay = Object.freeze({ lines: 2, details: resolveWorkflowRowDetails(undefined) });
export const WorkflowColumnRowDisplayContext = React.createContext<WorkflowColumnRowDisplay>(DEFAULT_DISPLAY);

/**
 * A workflow's sidebar row (scene 8 "Lines × details"): navigation only, no switch. Lines 1 is the name with what it
 * uses and, at its end, the state word in place of the run strip when it speaks. Lines 2 adds the state word leading
 * the trigger sentence, with the strip at the end. Lines 3 adds the next run to that line and the last run under the
 * strip. Each part shows only while its Row detail is on. The facts come from the one row reading the library page
 * draws (`readWorkflowLibraryRowFacts`).
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
  const { lines, details } = React.useContext(WorkflowColumnRowDisplayContext);
  const facts = React.useMemo(() => readWorkflowLibraryRowFacts(props.row), [props.row]);
  const marks = details.icons ? readWorkflowLibraryRowMarks(facts, props.row) : [];
  const trigger = !details.trigger ? null
    : facts.state === 'unavailable' ? (props.fallbackLine ?? facts.triggerLine)
      : (facts.triggerLine ?? props.fallbackLine ?? null);
  const nextRunAt = 'definition' in props.row ? props.row.definition.nextRunAt : null;
  const nextRun = lines === 3 && details.nextRun && nextRunAt !== null ? formatNextScheduledRun(nextRunAt) : null;
  const line = lines === 1 ? null : [trigger, nextRun].filter(Boolean).join(' · ') || null;
  const lastRun = lines === 3 && details.lastRun && facts.lastRunAt !== null
    ? t('workflows.destination.lastRun', { age: formatRelativeTimeShort(facts.lastRunAt, Date.now()) }) : null;
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
  const stateText = stateWord === null ? null
    : facts.state === 'needsYou' ? <StatusWord variant="attention" label={stateWord} /> : <Text style={styles.quiet}>{stateWord}</Text>;
  // State beats history: at one line the state word takes the strip's place (lab "Lines × details").
  const strip = details.recentRuns && facts.strip !== null && !(lines === 1 && stateText !== null)
    ? <WorkflowRunStripView strip={facts.strip} /> : null;
  const endState = lines === 1 && stateText !== null ? <Text variant="meta" numberOfLines={1}>{stateText}</Text> : null;
  const end = marks.length > 0 || strip !== null || endState !== null || lastRun !== null ? (
    <View style={lines === 1 ? styles.endOneLine : styles.end}>
      {marks.length > 0 || endState !== null ? (
        <View style={styles.endLine}>
          {endState}
          {marks.length > 0 ? <WorkflowMarks layout="cluster" marks={marks} /> : null}
        </View>
      ) : null}
      {strip}
      {lastRun === null ? null : <Text variant="meta" numberOfLines={1} style={styles.quiet}>{lastRun}</Text>}
    </View>
  ) : undefined;
  const lead = lines === 1 || stateText === null ? undefined : (
    <Text variant="meta" numberOfLines={1}>
      {stateText}
      {/* The row's mark slot keeps its own gap after the dot. */}
      {line ? <Text style={styles.quiet}>{' ·'}</Text> : null}
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
      accessibilityLabel={stateWord === null ? props.title : `${props.title}, ${stateWord}`}
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
  // Lines 1: everything at the end shares the title's one line (lab "Lines × details" 1 line).
  endOneLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s10,
  },
  endLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  quiet: {
    color: theme.colors.text.tertiary,
  },
}));
