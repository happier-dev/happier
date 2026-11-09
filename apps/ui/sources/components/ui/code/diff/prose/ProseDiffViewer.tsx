import * as React from 'react';
import { Platform, View, type ViewStyle } from 'react-native';
import { diffWords } from 'diff';
import { StyleSheet } from 'react-native-unistyles';

import { buildCodeLinesFromTextDiff } from '@/components/ui/code/model/buildCodeLinesFromTextDiff';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { Text } from '@/components/ui/text/Text';
import { VirtualizedList } from '@/components/ui/lists/virtualized/VirtualizedList';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { transcriptMarkdownTextStyle } from '@/components/sessions/transcript/transcriptMarkdownTypography';

import type { TextDiffViewerProps } from '../diffViewerTypes';
import { buildProseDiffSides, buildProseUnifiedLines, type ProseDiffLine, type ProseUnifiedLine } from './proseDiffSides';
import { useProseViewport } from './useProseViewport';
import { buildProseChangedLines } from './proseChangedWords';

/** The other side reads as set aside, not gone (lab su U: 55 %). */
const SET_ASIDE_OPACITY = 0.55;

/** First-paint guess for a virtualized prose row; the list measures the real rows. */
const ESTIMATED_ROW_HEIGHT = 28;

/**
 * R5, the prose face of the shared diff viewer (P6 U6.6, lab su U): instructions people read, not code.
 * Two labelled sides in the reading face, each with its own lines and numbers, side by side when
 * `presentationStyleOverride` is `split` and stacked otherwise; one column in document order when the
 * caller reads an edit rather than compares two versions (`prose.inline`). A changed line is a soft ink band; when the caller says which side is
 * kept, that side stays bright and the other is set aside.
 */
export const ProseDiffViewer = React.memo(function ProseDiffViewer(
  props: TextDiffViewerProps,
) {
  const contextLines = props.contextLines ?? 3;
  const codeLines = React.useMemo(
    () => buildCodeLinesFromTextDiff({ oldText: props.oldText, newText: props.newText, contextLines }),
    [contextLines, props.newText, props.oldText],
  );
  if (props.prose?.by !== undefined) {
    return <ProseBy testID={props.testID} by={props.prose.by} oldText={props.oldText} newText={props.newText} setAside={props.prose.kept === 'old'} />;
  }
  if (props.prose?.words === true) {
    return <ProseWords testID={props.testID} oldText={props.oldText} newText={props.newText} prose={props.prose} />;
  }
  if (props.prose?.inline === true) {
    return <ProseUnified testID={props.testID} codeLines={codeLines} />;
  }
  return <ProseSides {...props} codeLines={codeLines} />;
});

/**
 * One passage edited, read as a sentence: unchanged words in ink, removed words struck on the removed
 * band, added words on the added band. The labels name the two versions for assistive technology, which
 * cannot hear a strike-through.
 */
const ProseWords = React.memo(function ProseWords(
  props: Readonly<{ testID?: string; oldText: string; newText: string; prose: NonNullable<TextDiffViewerProps['prose']> }>,
) {
  const parts = React.useMemo(() => diffWords(props.oldText, props.newText), [props.newText, props.oldText]);
  const { oldLabel, newLabel } = props.prose;
  // In a Markdown body the edited paragraph keeps the body's paragraph scale, not the UI body role.
  const scale = props.prose.inBody === true ? transcriptMarkdownTextStyle : null;
  const spoken = typeof oldLabel === 'string' && typeof newLabel === 'string'
    ? `${oldLabel}: ${props.oldText}. ${newLabel}: ${props.newText}`
    : undefined;
  return (
    <Text variant="body" testID={props.testID} accessibilityLabel={spoken} style={[styles.words, scale]}>
      {parts.map((part, index) => (
        <React.Fragment key={index}>
          <Text
            variant="body"
            testID={part.added ? `${props.testID ?? 'prose'}.added` : part.removed ? `${props.testID ?? 'prose'}.removed` : undefined}
            style={[part.added ? styles.wordAdded : part.removed ? styles.wordRemoved : styles.wordSame, scale]}
          >
            {part.value}
          </Text>
          {/* What replaced a struck run starts after a space, never against it. */}
          {part.removed && parts[index + 1]?.added ? ' ' : null}
        </React.Fragment>
      ))}
    </Text>
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

/**
 * One column in document order, for an edit read top to bottom (an Agent's proposed instructions):
 * unchanged lines quiet and once, an added or removed line on its band with its mark.
 */
const ProseUnified = React.memo(function ProseUnified(
  props: Readonly<{ testID?: string; codeLines: ReturnType<typeof buildCodeLinesFromTextDiff> }>,
) {
  const lines: readonly ProseUnifiedLine[] = React.useMemo(() => buildProseUnifiedLines(props.codeLines), [props.codeLines]);
  const viewport = useProseViewport(lines);
  const rowTestIDPrefix = props.testID ?? 'prose';
  const renderRow = React.useCallback(
    (line: ProseUnifiedLine) => <ProseUnifiedRow line={line} testIDPrefix={rowTestIDPrefix} />,
    [rowTestIDPrefix],
  );
  return (
    <View testID={props.testID} style={styles.frame}>
      <ProseRows lines={lines} viewport={viewport} renderRow={renderRow} />
    </View>
  );
});

const ProseUnifiedRow = React.memo(function ProseUnifiedRow(
  props: Readonly<{ line: ProseUnifiedLine; testIDPrefix: string }>,
) {
  const { line } = props;
  if (line.kind === 'gap') {
    return (
      <Text variant="meta" style={styles.gap} accessibilityElementsHidden>
        ⋯
      </Text>
    );
  }
  return (
    <View
      testID={line.kind === 'same' ? undefined : `${props.testIDPrefix}.${line.kind}`}
      style={[styles.line, line.kind === 'added' ? styles.added : line.kind === 'removed' ? styles.removed : null]}
    >
      <Text variant="body" style={[styles.mark, line.kind === 'added' ? styles.markAdded : styles.markRemoved]}>
        {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}
      </Text>
      <Text
        variant="body"
        style={[
          styles.text,
          line.kind === 'same' ? null : styles.textChanged,
          line.kind === 'removed' ? styles.textRemoved : null,
        ]}
      >
        {line.text.length > 0 ? line.text : ' '}
      </Text>
    </View>
  );
});

/**
 * The rows of one prose column: in flow while small, inside the bounded viewport (the diff face's inline
 * virtualization policy) once the shown rows outgrow it, so a large rewrite never mounts every line.
 */
function ProseRows<T extends Readonly<{ id: string }>>(
  props: Readonly<{
    lines: readonly T[];
    viewport: ViewStyle | null;
    renderRow: (line: T) => React.ReactElement;
  }>,
) {
  if (props.viewport === null) {
    return (
      <View style={styles.body}>
        {props.lines.map((line) => (
          <React.Fragment key={line.id}>{props.renderRow(line)}</React.Fragment>
        ))}
      </View>
    );
  }
  return (
    <VirtualizedList
      style={props.viewport}
      contentContainerStyle={styles.body}
      data={props.lines}
      keyExtractor={(line) => line.id}
      renderItem={({ item }) => props.renderRow(item)}
      estimatedItemSize={ESTIMATED_ROW_HEIGHT}
      recycleItems={false}
    />
  );
}

const ProseSides = React.memo(function ProseSides(
  props: TextDiffViewerProps & Readonly<{ codeLines: ReturnType<typeof buildCodeLinesFromTextDiff> }>,
) {
  const sides = React.useMemo(() => buildProseDiffSides(props.codeLines), [props.codeLines]);
  const split = props.presentationStyleOverride === 'split';
  const kept = props.prose?.kept ?? null;
  const reducedMotion = useReducedMotionPreference();
  // A file only one side has (new in theirs, gone from theirs) reads as that one side, not beside a blank.
  const showOld = sides.old.length > 0 || sides.new.length === 0;
  const showNew = sides.new.length > 0;
  // A passage of one line per side has nothing to number.
  const numbered = sides.old.length > 1 || sides.new.length > 1;
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

const ProseSide = React.memo(function ProseSide(
  props: Readonly<{
    label: React.ReactNode | undefined;
    lines: readonly ProseDiffLine[];
    numbered: boolean;
    setAside: boolean;
    animate: boolean;
  }>,
) {
  const viewport = useProseViewport(props.lines);
  const { numbered, setAside, animate } = props;
  const renderRow = React.useCallback(
    (line: ProseDiffLine) => <ProseSideRow line={line} numbered={numbered} setAside={setAside} animate={animate} />,
    [animate, numbered, setAside],
  );
  return (
    <View style={styles.side}>
      {props.label ? <View style={styles.head}>
        {typeof props.label === 'string' ? <Text variant="meta" emphasis="medium" style={styles.label}>{props.label}</Text> : props.label}
      </View> : null}
      <ProseRows lines={props.lines} viewport={viewport} renderRow={renderRow} />
    </View>
  );
});

const ProseSideRow = React.memo(function ProseSideRow(
  props: Readonly<{ line: ProseDiffLine; numbered: boolean; setAside: boolean; animate: boolean }>,
) {
  const { line } = props;
  // Choosing a side is visible in the content: the set-aside side's changes dim (lab su U motion, 180 ms).
  const transition =
    Platform.OS === 'web' && props.animate
      ? ({
          transitionProperty: 'opacity, background-color',
          transitionDuration: `${motionTokens.durationMs.fast}ms`,
          transitionTimingFunction: 'ease-out',
        } as object)
      : null;
  if (line.kind === 'gap') {
    return (
      <Text variant="meta" style={styles.gap} accessibilityElementsHidden>
        ⋯
      </Text>
    );
  }
  return (
    <View
      style={[
        styles.line,
        props.numbered ? null : styles.unnumbered,
        line.kind === 'changed' ? (props.setAside ? styles.changedAside : styles.changed) : null,
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
          line.kind === 'changed' && props.setAside ? styles.textAside : null,
          transition,
        ]}
      >
        {line.text.length > 0 ? line.text : ' '}
      </Text>
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
  // The unified reading's change bands and marks: the diff roles, so an addition reads as one wherever it shows.
  added: { backgroundColor: theme.colors.diff.added.background },
  removed: { backgroundColor: theme.colors.diff.removed.background },
  mark: { width: theme.space.s12, textAlign: 'center', marginLeft: theme.space.s4 },
  markAdded: { color: theme.colors.diff.added.border },
  markRemoved: { color: theme.colors.diff.removed.border },
  textRemoved: { textDecorationLine: 'line-through' },
  gap: { paddingLeft: theme.space.s32 + theme.space.s8, color: theme.colors.text.tertiary },
  words: { color: theme.colors.text.primary },
  byRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', columnGap: theme.space.s16, rowGap: theme.space.s4,
    paddingVertical: theme.space.s4 },
  // The name column holds a short display name; the lines take the rest, and a narrow column (a phone) puts the
  // name above its lines instead of spending a third of the width on it.
  byLabel: { width: theme.space.s48 * 2, color: theme.colors.text.secondary, paddingTop: theme.space.s2 },
  byLines: { flexGrow: 1, flexShrink: 1, flexBasis: theme.space.s48 * 6, minWidth: 0, gap: theme.space.s4 },
  byUnchanged: { color: theme.colors.text.secondary },
  byText: { color: theme.colors.text.primary },
  byChanged: { color: theme.colors.text.primary, backgroundColor: theme.colors.diff.added.background },
  wordSame: { color: theme.colors.text.primary },
  wordAdded: { color: theme.colors.text.primary, backgroundColor: theme.colors.diff.added.background },
  wordRemoved: {
    color: theme.colors.text.secondary,
    backgroundColor: theme.colors.diff.removed.background,
    textDecorationLine: 'line-through',
  },
}));
