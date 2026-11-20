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
  readWorkflowLineThree,
  resolveWorkflowRowDetails,
  type WorkflowLibraryItem,
  type WorkflowRowDetails,
} from '../library/workflowLibraryCells';
import { WorkflowRunStripView } from '../library/WorkflowRunStripView';
import { readCollectionPluginDetails, type CollectionListExtensions } from '@/components/ui/lists/collection/useCollectionListExtensions';
import { WorkflowMarks } from '../presentation/WorkflowMarks';

/**
 * The sidebar's Lines and Row details, from the one display owner (scene 8 View menu): the built-ins resolved, the
 * stored choices as set, and the plugin details the list admits (`ui.listExtensions`), as the library page reads them.
 */
export type WorkflowColumnRowDisplay = Readonly<{
  lines: 1 | 2 | 3;
  details: WorkflowRowDetails;
  stored: Readonly<Record<string, boolean>> | undefined;
  pluginDetails: CollectionListExtensions<WorkflowLibraryItem>['details'];
}>;
const DEFAULT_DISPLAY: WorkflowColumnRowDisplay = Object.freeze({ lines: 2, details: resolveWorkflowRowDetails(undefined),
  stored: undefined, pluginDetails: Object.freeze([]) });
export const WorkflowColumnRowDisplayContext = React.createContext<WorkflowColumnRowDisplay>(DEFAULT_DISPLAY);
const NO_LINE_THREE = Object.freeze({ start: null, end: null });

/**
 * A workflow's sidebar row (scene 8 "Lines × details"): navigation only, no switch. Lines 1 is the name with what it
 * uses and, at its end, the state word in place of the run strip when it speaks. Lines 2 adds the state word leading
 * the trigger sentence, with the strip at the end. Lines 3 adds its own third line, read by `readWorkflowLineThree`.
 * Each part shows only while its Row detail is on. The facts come from the one row reading the library page draws
 * (`readWorkflowLibraryRowFacts`).
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
  const { lines, details, stored, pluginDetails } = React.useContext(WorkflowColumnRowDisplayContext);
  const facts = React.useMemo(() => readWorkflowLibraryRowFacts(props.row), [props.row]);
  const marks = details.icons ? readWorkflowLibraryRowMarks(facts, props.row) : [];
  const trigger = !details.trigger ? null
    : facts.state === 'unavailable' ? (props.fallbackLine ?? facts.triggerLine)
      : (facts.triggerLine ?? props.fallbackLine ?? null);
  const pluginContext = lines === 1 ? null : readCollectionPluginDetails(pluginDetails, stored, props.row, 'context');
  const pluginMark = readCollectionPluginDetails(pluginDetails, stored, props.row, 'mark');
  const line = lines === 1 ? null : [trigger, pluginContext].filter(Boolean).join(' · ') || null;
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
  // Lines 3 (lab "Lines × details"): its own line under line 2, the next run (and steps) at its start, the last run at
  // its end, as the index's list rows draw it.
  const { start: lineThreeStart, end: lastRun } = lines === 3 ? readWorkflowLineThree(props.row, facts, details, Date.now()) : NO_LINE_THREE;
  const detailLines = lines === 3 && (lineThreeStart !== null || lastRun !== null)
    ? [{ key: 'line-3', start: lineThreeStart, end: lastRun }] : undefined;
  const end = marks.length > 0 || strip !== null || endState !== null || pluginMark !== null ? (
    <View style={lines === 1 ? styles.endOneLine : styles.end}>
      {marks.length > 0 || endState !== null || pluginMark !== null ? (
        <View style={styles.endLine}>
          {endState}
          {pluginMark === null ? null : <Text variant="meta" numberOfLines={1} style={styles.quiet}>{pluginMark}</Text>}
          {marks.length > 0 ? <WorkflowMarks layout="cluster" marks={marks} /> : null}
        </View>
      ) : null}
      {strip}
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
      {...(detailLines === undefined ? {} : { lines: detailLines })}
      accessibilityLabel={[props.title, stateWord, lineThreeStart, lines === 3 ? lastRun : null].filter(Boolean).join(', ')}
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
