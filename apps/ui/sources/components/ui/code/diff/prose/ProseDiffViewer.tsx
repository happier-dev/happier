import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { buildCodeLinesFromTextDiff } from '@/components/ui/code/model/buildCodeLinesFromTextDiff';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

import type { TextDiffViewerProps } from '../diffViewerTypes';
import { buildProseDiffSides, type ProseDiffLine } from './proseDiffSides';
import { buildProseChangedLines } from './proseChangedWords';

/** The other side reads as set aside, not gone (lab su U: 55 %). */
const SET_ASIDE_OPACITY = 0.55;

/**
 * R5, the prose face of the shared diff viewer (P6 U6.6, lab su U): instructions people read, not code.
 * Two labelled sides in the reading face, each with its own lines and numbers, side by side when
 * `presentationStyleOverride` is `split` and stacked otherwise. A changed line is a soft ink band; when
 * the caller says which side is kept, that side stays bright and the other is set aside.
 */
export const ProseDiffViewer = React.memo(function ProseDiffViewer(
  props: TextDiffViewerProps,
) {
  const contextLines = props.contextLines ?? 3;
  const sides = React.useMemo(
    () =>
      buildProseDiffSides(
        buildCodeLinesFromTextDiff({
          oldText: props.oldText,
          newText: props.newText,
          contextLines,
        }),
      ),
    [contextLines, props.newText, props.oldText],
  );
  const split = props.presentationStyleOverride === 'split';
  const kept = props.prose?.kept ?? null;
  const reducedMotion = useReducedMotionPreference();
  // A file only one side has (new in theirs, gone from theirs) reads as that one side, not beside a blank.
  const showOld = sides.old.length > 0 || sides.new.length === 0;
  const showNew = sides.new.length > 0;
  // A passage of one line per side has nothing to number.
  const numbered = sides.old.length > 1 || sides.new.length > 1;
  if (props.prose?.by !== undefined) {
    return <ProseBy testID={props.testID} by={props.prose.by} oldText={props.oldText} newText={props.newText} setAside={props.prose.kept === 'old'} />;
  }
  return (
    <View testID={props.testID} style={[styles.frame, split ? styles.row : null]}>
      {showOld ? (
        <ProseSide label={props.prose?.oldLabel} lines={sides.old} numbered={numbered} setAside={kept === 'new'} animate={!reducedMotion} />
      ) : null}
      {showOld && showNew ? <View style={split ? styles.ruleVertical : styles.ruleHorizontal} /> : null}
      {showNew ? (
        <ProseSide label={props.prose?.newLabel} lines={sides.new} numbered={numbered} setAside={kept === 'old'} animate={!reducedMotion} />
      ) : null}
    </View>
  );
});

/**
 * One person's version against the base: the name in a quiet column, then only the lines they changed, each in
 * the reading face with their changed words on the added band. Two of these, one per person, compare a line both
 * edited without line numbers or the rest of the document.
 */
const ProseBy = React.memo(function ProseBy(
  props: Readonly<{ testID?: string; by: string; oldText: string; newText: string; setAside: boolean }>,
) {
  const lines = React.useMemo(() => buildProseChangedLines(props.oldText, props.newText), [props.newText, props.oldText]);
  if (lines.length === 0) return null;
  return (
    <View testID={props.testID} style={[styles.byRow, props.setAside ? styles.textAside : null]}>
      <Text variant="meta" style={styles.byLabel} numberOfLines={1}>{props.by}</Text>
      <View style={styles.byLines}>
        {lines.map((line, index) => (
          <Text key={index} variant="body" style={styles.byText}>
            {line.map((run, runIndex) => (
              <Text key={runIndex} variant="body" testID={run.changed ? `${props.testID ?? 'prose'}.changed` : undefined}
                style={run.changed ? styles.byChanged : styles.byUnchanged}>{run.text}</Text>
            ))}
          </Text>
        ))}
      </View>
    </View>
  );
});

const ProseSide = React.memo(function ProseSide(
  props: Readonly<{
    label: React.ReactNode | undefined;
    lines: readonly ProseDiffLine[];
    numbered: boolean;
    setAside: boolean;
    animate: boolean;
  }>,
) {
  // Choosing a side is visible in the content: the set-aside side's changes dim (lab su U motion, 180 ms).
  const transition =
    Platform.OS === 'web' && props.animate
      ? ({
          transitionProperty: 'opacity, background-color',
          transitionDuration: `${motionTokens.durationMs.fast}ms`,
          transitionTimingFunction: 'ease-out',
        } as object)
      : null;
  return (
    <View style={styles.side}>
      {props.label ? <View style={styles.head}>
        {typeof props.label === 'string' ? <Text variant="meta" emphasis="medium" style={styles.label}>{props.label}</Text> : props.label}
      </View> : null}
      <View style={styles.body}>
        {props.lines.map((line) =>
          line.kind === 'gap' ? (
            <Text
              key={line.id}
              variant="meta"
              style={styles.gap}
              accessibilityElementsHidden
            >
              ⋯
            </Text>
          ) : (
            <View
              key={line.id}
              style={[
                styles.line,
                props.numbered ? null : styles.unnumbered,
                line.kind === 'changed'
                  ? props.setAside
                    ? styles.changedAside
                    : styles.changed
                  : null,
                transition,
              ]}
            >
              {props.numbered ? (
                <Text variant="micro" style={styles.number}>
                  {line.number === null ? '' : String(line.number)}
                </Text>
              ) : null}
              <Text
                variant="body"
                style={[
                  styles.text,
                  line.kind === 'changed' ? styles.textChanged : null,
                  line.kind === 'changed' && props.setAside
                    ? styles.textAside
                    : null,
                  transition,
                ]}
              >
                {line.text.length > 0 ? line.text : ' '}
              </Text>
            </View>
          ),
        )}
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  frame: {
    borderRadius: theme.borderRadius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.default,
    overflow: 'hidden',
  },
  row: { flexDirection: 'row' },
  ruleVertical: {
    width: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.border.default,
  },
  ruleHorizontal: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.border.default,
  },
  side: { flex: 1, minWidth: 0 },
  head: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s12,
    paddingVertical: theme.space.s8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border.default,
  },
  body: { paddingVertical: theme.space.s4 },
  line: {
    flexDirection: 'row',
    // The number sits on its line's first baseline, however the line wraps.
    alignItems: 'baseline',
    gap: theme.space.s8,
    paddingVertical: theme.space.s2,
    paddingRight: theme.space.s12,
  },
  changed: { backgroundColor: theme.colors.surface.selected },
  changedAside: { backgroundColor: theme.colors.surface.inset },
  number: {
    width: theme.space.s32,
    textAlign: 'right',
    color: theme.colors.text.tertiary,
    ...Typography.mono(),
    fontVariant: ['tabular-nums'],
  },
  text: { flex: 1, minWidth: 0, color: theme.colors.text.secondary },
  label: { color: theme.colors.text.secondary },
  unnumbered: { paddingLeft: theme.space.s12 },
  textChanged: { color: theme.colors.text.primary },
  textAside: { opacity: SET_ASIDE_OPACITY },
  gap: { paddingLeft: theme.space.s32 + theme.space.s8, color: theme.colors.text.tertiary },
  byRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', columnGap: theme.space.s16, rowGap: theme.space.s4,
    paddingVertical: theme.space.s4 },
  // The name column holds a short display name; the lines take the rest, and a narrow column (a phone) puts the
  // name above its lines instead of spending a third of the width on it.
  byLabel: { width: theme.space.s48 * 2, color: theme.colors.text.secondary, paddingTop: theme.space.s2 },
  byLines: { flexGrow: 1, flexShrink: 1, flexBasis: theme.space.s48 * 6, minWidth: 0, gap: theme.space.s4 },
  byUnchanged: { color: theme.colors.text.secondary },
  byText: { color: theme.colors.text.primary },
  byChanged: { color: theme.colors.text.primary, backgroundColor: theme.colors.diff.added.background },
}));
