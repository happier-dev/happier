import { Fragment, memo, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { HappierSpinner } from '../feedback/Spinner.js';
import { happierFocusRingStyle } from '../interaction/focusVisible.js';
import { HappierPressable } from '../interaction/Pressable.js';
import { HAPPIER_PRESS_FEEDBACK_V1 } from '../interaction/pressFeedback.js';
import type { HappierPortableStyle, HappierStyleProp } from '../portableTypes.js';
import { resolveHappierWorkStatusWordColor, type HappierWorkStatusTone } from './workStatus.js';
import {
  HAPPIER_WORK_PANE_METRICS,
  resolveHappierWorkHost,
  useHappierWorkTheme,
  type HappierWorkHost,
  type HappierWorkTextRole,
  type HappierWorkTheme,
} from './workTheme.js';

/**
 * A Work row: one unit of agent work as every Work list draws it (unified-work lab `session-A`).
 *
 * - {@link HappierWorkRowShell} is the pressable shell every row in a Work pane shares — the hover,
 *   selected and keyboard-focus states and the indent of work under its lead — around whatever
 *   summary it draws.
 * - {@link HappierWorkSummary} is the identity leaf: the work's mark with its state in the corner (a
 *   live indicator while working, an amber dot while it waits on a person), the title, one quiet line
 *   of facts, and the owner's state word at the trailing edge. It is a LEAF: no surface, no padding,
 *   no press behaviour, so a row, a details card or a transcript reference each wrap it in their own
 *   geometry.
 *
 * A row carries no answer controls: a row that needs the person says so and opens where the request
 * is answered once.
 *
 * Extracted from Happier core's `WorkItemRow` (`WorkRowShell`) and `SessionAgentActivitySummary`,
 * which now bind these to the app's theme, text owner, Agent marks and activity spinner.
 */

/** Each nesting level of work under its lead. */
const LEVEL_INDENT_PX = 24;
const MARK_SIZE_PX = 30;
const SEPARATOR = ' · ';

const styles = StyleSheet.create({
  summary: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, minWidth: 0 },
  mark: { width: MARK_SIZE_PX, height: MARK_SIZE_PX },
  // The corner badge sits on the pane's paper so it reads as cut out of the mark.
  badge: {
    position: 'absolute',
    right: -3,
    bottom: -3,
    width: 13,
    height: 13,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attentionDot: { width: 7, height: 7, borderRadius: 4 },
  copy: { flex: 1, minWidth: 0 },
});

// Styles handed to the shared pressable and the host's text are portable styles.
const ROW_STYLE: HappierPortableStyle = {
  borderRadius: 10,
  borderWidth: HAPPIER_WORK_PANE_METRICS.rowRingPx,
  borderColor: 'transparent',
  paddingHorizontal: HAPPIER_WORK_PANE_METRICS.rowPaddingPx,
  paddingVertical: 8,
  minHeight: 52,
  justifyContent: 'center',
};
const LINE_STYLE: HappierPortableStyle = { marginTop: 1 };
const TIME_STYLE: HappierPortableStyle = { flexShrink: 0 };
const TRAILING_STATE_STYLE: HappierPortableStyle = { flexShrink: 0, maxWidth: '45%' };

export type HappierWorkRowShellProps = Readonly<{
  testID: string;
  accessibilityLabel: string;
  selected?: boolean;
  /** How deep under its lead the work sits; each level indents the row. */
  level?: number;
  onPress: () => void;
  children: ReactNode;
  /** Omitted inside a mounted plugin surface: the environment's theme. */
  theme?: HappierWorkTheme;
}>;

export const HappierWorkRowShell = memo(function HappierWorkRowShell(props: HappierWorkRowShellProps) {
  const theme = useHappierWorkTheme(props.theme);
  const level = props.level ?? 0;
  const selected = props.selected === true;
  return (
    <View style={level > 0 ? { paddingLeft: level * LEVEL_INDENT_PX } : null}>
      <HappierPressable
        testID={props.testID}
        accessibilityRole="button"
        accessibilityLabel={props.accessibilityLabel}
        selected={selected}
        onPress={props.onPress}
        style={({ hovered, focused, pressed }) => [
          ROW_STYLE,
          hovered ? { backgroundColor: theme.colors.hover } : null,
          selected ? { backgroundColor: theme.colors.selected } : null,
          happierFocusRingStyle({ visible: focused, color: theme.colors.focus }),
          { opacity: pressed ? HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle : 1 },
        ]}
      >
        {props.children}
      </HappierPressable>
    </View>
  );
});

/**
 * Where the work stands, as its mark's corner says it: `attention` (an amber dot), `live` (a live
 * indicator) or `finished` (nothing).
 */
export type HappierWorkSummaryPhase = 'attention' | 'live' | 'finished';

export type HappierWorkSummaryProps = Readonly<{
  title: string;
  phase: HappierWorkSummaryPhase;
  /** The work's mark (an Agent mark, an avatar), drawn at 30pt. */
  mark: ReactNode;
  /** The corner's live indicator while `live`; omitted, the shared spinner. */
  liveIndicator?: ReactNode;
  /**
   * The one quiet line, in order, joined by " · ". Lead with the fact that matters (what it needs
   * from the person, how long it has run); a `HappierWorkStatusWord` draws a fact in a state tone.
   */
  facts: readonly ReactNode[];
  /** A short date at the trailing edge ("2h"); omitted while live. */
  trailingTime?: string | null;
  /** The owner's state word at the trailing edge: the row then says where the work stands once. */
  trailingState?: Readonly<{ word: string; tone: HappierWorkStatusTone }> | null;
  accessibilityLabel: string;
  /** Prefix for this instance's test ids. */
  testID?: string;
  /** Omitted inside a mounted plugin surface: the environment's theme. */
  theme?: HappierWorkTheme;
  /** Omitted inside a mounted plugin surface: the environment's text. */
  host?: HappierWorkHost;
}>;

export const HappierWorkSummary = memo(function HappierWorkSummary(props: HappierWorkSummaryProps) {
  const theme = useHappierWorkTheme(props.theme);
  const host = resolveHappierWorkHost(props.host);
  const { Text } = host;
  const { phase, testID } = props;
  const trailingState = props.trailingState ?? null;
  const trailingTime = props.trailingTime ?? '';

  return (
    <View testID={testID} accessible accessibilityLabel={props.accessibilityLabel} style={styles.summary}>
      <View style={styles.mark}>
        {props.mark}
        {phase === 'attention' ? (
          <View
            testID={testID ? `${testID}:attention-dot` : undefined}
            style={[styles.badge, { backgroundColor: theme.colors.surface }]}
          >
            <View style={[styles.attentionDot, { backgroundColor: theme.colors.attention.foreground }]} />
          </View>
        ) : phase === 'live' ? (
          <View testID={testID ? `${testID}:live` : undefined} style={[styles.badge, { backgroundColor: theme.colors.surface }]}>
            {props.liveIndicator ?? <HappierSpinner size={9} color={theme.colors.secondaryText} />}
          </View>
        ) : null}
      </View>
      <View style={styles.copy}>
        <Text role="rowTitle" strong={phase === 'attention'} numberOfLines={1} style={{ color: theme.colors.text }}>
          {props.title}
        </Text>
        {props.facts.length > 0 ? (
          <Text
            role="rowLine"
            testID={testID ? `${testID}:facts` : undefined}
            numberOfLines={1}
            style={[LINE_STYLE, { color: theme.colors.secondaryText }]}
          >
            {props.facts.map((fact, index) => (
              <Fragment key={index}>
                {index > 0 ? <Text role="rowLine" style={{ color: theme.colors.mutedText }}>{SEPARATOR}</Text> : null}
                {fact}
              </Fragment>
            ))}
          </Text>
        ) : null}
      </View>
      {trailingTime ? (
        <Text role="rowTime" style={[TIME_STYLE, { color: theme.colors.mutedText }]}>{trailingTime}</Text>
      ) : null}
      {trailingState ? (
        <HappierWorkStatusWord
          role="rowState"
          tone={trailingState.tone}
          testID={testID ? `${testID}:state:label` : undefined}
          numberOfLines={1}
          style={TRAILING_STATE_STYLE}
          theme={theme}
          host={host}
        >
          {trailingState.word}
        </HappierWorkStatusWord>
      ) : null}
    </View>
  );
});

/**
 * A state word in the one work-status treatment: quiet while healthy, strong and in the state's hue
 * when it needs the person (`attention`) or is in trouble (`danger`). Inside a fact line it inherits
 * the line's role; at a map node's trailing edge pass `rowState`.
 */
export function HappierWorkStatusWord(props: Readonly<{
  tone: HappierWorkStatusTone;
  children: ReactNode;
  role?: HappierWorkTextRole;
  numberOfLines?: number;
  /** Layout only (flex, width); the tone owns the colour and weight. */
  style?: HappierStyleProp;
  testID?: string;
  theme?: HappierWorkTheme;
  host?: HappierWorkHost;
}>) {
  const theme = useHappierWorkTheme(props.theme);
  const { Text } = resolveHappierWorkHost(props.host);
  const color = resolveHappierWorkStatusWordColor(props.tone, theme.colors);
  return (
    <Text
      role={props.role ?? 'rowLine'}
      strong={color !== null}
      style={[props.style, { color: color ?? theme.colors.secondaryText }]}
      {...(props.numberOfLines === undefined ? {} : { numberOfLines: props.numberOfLines })}
      {...(props.testID === undefined ? {} : { testID: props.testID })}
    >
      {props.children}
    </Text>
  );
}
