import { memo, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { HappierSpinner } from '../feedback/Spinner.js';
import { HappierFactLine } from './FactLine.js';
import { happierFocusRingStyle } from '../interaction/focusVisible.js';
import { HappierPressable, type HappierPressableProps } from '../interaction/Pressable.js';
import { HAPPIER_PRESS_FEEDBACK_V1 } from '../interaction/pressFeedback.js';
import { HAPPIER_PAGE_METRICS } from '../layout/pageMetrics.js';
import { HAPPIER_PAGE_TEXT } from '../layout/pageText.js';
import { happierPageRowDividerWidth, useHappierPageSection } from '../layout/PageSection.js';
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
/** Between a row's mark and its text. */
const MARK_TEXT_GAP_PX = 10;

const styles = StyleSheet.create({
  summary: { flexDirection: 'row', alignItems: 'flex-start', gap: MARK_TEXT_GAP_PX, minWidth: 0 },
  // A glyph smaller than the identity slot sits at its centre, level with the title (DESIGN-15 R5).
  mark: { width: MARK_SIZE_PX, height: MARK_SIZE_PX, alignItems: 'center', justifyContent: 'center' },
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
  // A title in two runs: the start gives way with its own ellipsis, the end stays whole.
  splitTitle: { flexDirection: 'row', minWidth: 0 },
});

const ROW_PADDING_VERTICAL_PX = 8;
// Styles handed to the shared pressable and the host's text are portable styles.
const ROW_STYLE: HappierPortableStyle = {
  borderRadius: 10,
  borderWidth: HAPPIER_WORK_PANE_METRICS.rowRingPx,
  borderColor: 'transparent',
  paddingHorizontal: HAPPIER_WORK_PANE_METRICS.rowPaddingPx,
  paddingVertical: ROW_PADDING_VERTICAL_PX,
  minHeight: 52,
  justifyContent: 'center',
};
const LINE_STYLE: HappierPortableStyle = { marginTop: 1 };
const BYLINE_STYLE: HappierPortableStyle = { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4, minWidth: 0 };
const BYLINE_TEXT_STYLE: HappierPortableStyle = { flexShrink: 1, minWidth: 0 };
const TIME_STYLE: HappierPortableStyle = { flexShrink: 0 };
const TITLE_HEAD_STYLE: HappierPortableStyle = { flexShrink: 1, minWidth: 0 };
const TITLE_TAIL_STYLE: HappierPortableStyle = { flexShrink: 0, maxWidth: '100%' };
/** Keeps the word gap between the two runs of a split title; an ordinary space would collapse. */
const NON_BREAKING_SPACE = '\u00A0';
const TRAILING_STATE_STYLE: HappierPortableStyle = { flexShrink: 0, maxWidth: '45%' };
/**
 * A row with its own control (Review, Settle, ⋯): the control keeps the row's inset from the sheet's
 * edge and a row padding's breath after the row's meta, so it never sits flush on the edge (lab
 * `inbox-I1`, `inbox-I2`).
 */
const TRAILING_ACCESSORY_ROW_STYLE = {
  flexDirection: 'row',
  alignItems: 'center',
  gap: HAPPIER_WORK_PANE_METRICS.rowPaddingPx,
  paddingRight: HAPPIER_WORK_PANE_METRICS.rowInsetPx,
} as const;

/**
 * How a Work row is sized: `pane` (the default) is the Work pane's compact live list; `page` is a page
 * made of Work rows (the Inbox, lab `inbox-I1`): the page row's text inset, height and type steps, so
 * the rows read at the scale of the page header and section titles around them.
 */
export type HappierWorkRowDensity = 'pane' | 'page';

/** A page row's text starts on the page sheet's row inset; its ring is part of that inset. */
const PAGE_ROW_PADDING_PX = HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx - HAPPIER_WORK_PANE_METRICS.rowRingPx;
/**
 * Where a page row's text column starts, from the row's outer edge (its ring, padding, mark and gap).
 * Content that belongs to a row and sits under it (an inline answer, a request preview) starts here,
 * so it reads as part of the row rather than as a block inside the sheet (lab `phone-P4`).
 */
export const HAPPIER_WORK_PAGE_ROW_METRICS = Object.freeze({
  textInsetPx: HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx + MARK_SIZE_PX + MARK_TEXT_GAP_PX,
  /** The row's trailing inset, matching its leading padding. */
  trailingInsetPx: HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx,
});
/** Where a pane row's text column starts: the same mark-and-gap measure as a page row, on the pane's inset. */
const PANE_ROW_TEXT_INSET_PX = HAPPIER_WORK_PANE_METRICS.rowInsetPx + MARK_SIZE_PX + MARK_TEXT_GAP_PX;
/**
 * Every page row holds a title and its one line, so a title-only row between described ones keeps their
 * height and the sheet reads as even rows (a description is what a row may lack, not a different row).
 */
const PAGE_ROW_MIN_HEIGHT_PX = Math.max(
  HAPPIER_PAGE_METRICS.rowMinHeightPx,
  HAPPIER_PAGE_TEXT.rowTitle.lineHeight + HAPPIER_PAGE_TEXT.rowDescription.lineHeight
    + 2 * (ROW_PADDING_VERTICAL_PX + HAPPIER_WORK_PANE_METRICS.rowRingPx),
);
const PAGE_ROW_STYLE: HappierPortableStyle = {
  paddingHorizontal: PAGE_ROW_PADDING_PX,
  minHeight: PAGE_ROW_MIN_HEIGHT_PX,
};
/**
 * The page row's date column (craft: meta in one right-aligned tabular column). It closes the row at the
 * sheet's edge, after the row's own control, so dates line up however wide each row's control is and the
 * controls share a right edge. The width holds a short date ("59m", "23h") at `pageRowTime`.
 */
const PAGE_META_COLUMN_STYLE: HappierPortableStyle = { minWidth: 30, alignItems: 'flex-end' };
const PAGE_TRAILING_ACCESSORY_ROW_STYLE = {
  ...TRAILING_ACCESSORY_ROW_STYLE,
  paddingRight: PAGE_ROW_PADDING_PX,
} as const;
/** A page row centres its mark on its two lines (lab `.uwr-ib-row`), keeping the 30pt identity slot. */
const PAGE_SUMMARY_STYLE = { alignItems: 'center' } as const;
const TEXT_ROLES = Object.freeze({
  pane: Object.freeze({ title: 'rowTitle', line: 'rowLine', time: 'rowTime', state: 'rowState' }),
  page: Object.freeze({ title: 'pageRowTitle', line: 'pageRowLine', time: 'pageRowTime', state: 'pageRowState' }),
} as const satisfies Record<HappierWorkRowDensity, Readonly<Record<'title' | 'line' | 'time' | 'state', HappierWorkTextRole>>>);

export type HappierWorkRowShellProps = Readonly<{
  testID: string;
  accessibilityLabel: string;
  selected?: boolean;
  expanded?: HappierPressableProps['expanded'];
  controlRef?: HappierPressableProps['controlRef'];
  accessibilityActions?: HappierPressableProps['accessibilityActions'];
  onAccessibilityAction?: HappierPressableProps['onAccessibilityAction'];
  /** Independent row actions stay outside the navigation button's accessibility/event subtree. */
  trailingAccessory?: ReactNode;
  /**
   * Independent row actions set beneath the row's text (a phone's Deny / Allow once, lab coordination
   * `P4-Ap`) instead of beside it: aligned to the text column of a row that leads with a mark, closed by
   * the row's own padding, and outside the navigation button like {@link trailingAccessory}.
   */
  belowAccessory?: ReactNode;
  /**
   * A page row's date, in its own trailing column after {@link trailingAccessory}. `null` keeps the
   * column empty, for a row with no date among rows with one; omitted, the row has no column.
   */
  trailingMeta?: ReactNode;
  /** How deep under its lead the work sits; each level indents the row. */
  level?: number;
  /** `pane` (default) or `page`: see {@link HappierWorkRowDensity}. */
  density?: HappierWorkRowDensity;
  /**
   * A `page` row on a page sheet draws the sheet's full-width row hairline under it, as every page
   * row does; the sheet passes it (`withHappierPageSectionDividers`) and the last row draws none.
   */
  showDivider?: boolean;
  onPress: () => void;
  onLongPress?: HappierPressableProps['onLongPress'];
  onContextMenu?: HappierPressableProps['onContextMenu'];
  children: ReactNode;
  /** Omitted inside a mounted plugin surface: the environment's theme. */
  theme?: HappierWorkTheme;
  /** Omitted inside a mounted plugin surface: the environment's text. */
  host?: HappierWorkHost;
}>;

export const HappierWorkRowShell = memo(function HappierWorkRowShell(props: HappierWorkRowShellProps) {
  const theme = useHappierWorkTheme(props.theme);
  const { Text } = resolveHappierWorkHost(props.host);
  const hasMetaColumn = props.trailingMeta !== undefined;
  const hasTrailing = Boolean(props.trailingAccessory) || hasMetaColumn;
  const level = props.level ?? 0;
  const selected = props.selected === true;
  const page = props.density === 'page';
  const pageSection = useHappierPageSection();
  const divider = page && props.showDivider === true && pageSection !== null ? (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: happierPageRowDividerWidth(),
        backgroundColor: pageSection.rowDividerColor,
      }}
    />
  ) : null;
  // A page row is selected as a whole, its own control included (lab `inbox-I1`): the fill spans the
  // row edge to edge under the sheet's hairlines, rather than stopping at the control.
  const rowSelected = page && selected;
  return (
    <View style={[level > 0 ? { paddingLeft: level * LEVEL_INDENT_PX } : null,
      rowSelected ? { backgroundColor: theme.colors.selected, borderRadius: ROW_STYLE.borderRadius } : null]}>
      <View style={hasTrailing ? (page ? PAGE_TRAILING_ACCESSORY_ROW_STYLE : TRAILING_ACCESSORY_ROW_STYLE) : null}>
        <HappierPressable
          testID={props.testID}
          accessibilityRole="button"
          accessibilityLabel={props.accessibilityLabel}
          selected={selected}
          expanded={props.expanded}
          controlRef={props.controlRef}
          accessibilityActions={props.accessibilityActions}
          onAccessibilityAction={props.onAccessibilityAction}
          onPress={props.onPress}
          onLongPress={props.onLongPress}
          onContextMenu={props.onContextMenu}
          style={({ hovered, focused, pressed }) => [
            ROW_STYLE,
            page ? PAGE_ROW_STYLE : null,
            hasTrailing ? { flex: 1, minWidth: 0 } : null,
            // The open row already carries its fill; the hover paint would cover it.
            hovered && !rowSelected ? { backgroundColor: theme.colors.hover } : null,
            selected && !rowSelected ? { backgroundColor: theme.colors.selected } : null,
            happierFocusRingStyle({ visible: focused, color: theme.colors.focus }),
            { opacity: pressed ? HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle : 1 },
          ]}
        >
          {props.children}
        </HappierPressable>
        {props.trailingAccessory}
        {hasMetaColumn ? (
          <View testID={`${props.testID}:meta`} style={PAGE_META_COLUMN_STYLE}>
            {props.trailingMeta ? (
              <Text role={TEXT_ROLES[page ? 'page' : 'pane'].time} style={{ color: theme.colors.mutedText }}>{props.trailingMeta}</Text>
            ) : null}
          </View>
        ) : null}
      </View>
      {props.belowAccessory ? (
        <View
          testID={`${props.testID}:below`}
          style={{
            paddingLeft: page ? HAPPIER_WORK_PAGE_ROW_METRICS.textInsetPx : PANE_ROW_TEXT_INSET_PX,
            paddingRight: page ? HAPPIER_WORK_PAGE_ROW_METRICS.trailingInsetPx : HAPPIER_WORK_PANE_METRICS.rowInsetPx,
            paddingBottom: HAPPIER_WORK_PANE_METRICS.rowPaddingPx,
          }}
        >
          {props.belowAccessory}
        </View>
      ) : null}
      {divider}
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
  /**
   * Where the title's distinguishing end starts, for rows named from one stem ("… child A",
   * "… child B"). When the row is too narrow, the start truncates and this end stays whole, so
   * sibling rows never read the same. Omitted, the title truncates at its end.
   */
  titleTailStart?: number | null;
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
  /** Who it involves, one muted line under the facts ("Ana asked you"); its avatar leads it. */
  byline?: Readonly<{ text: string; leading?: ReactNode }> | null;
  /** A short date at the trailing edge ("2h"); omitted while live. */
  trailingTime?: ReactNode;
  /** The owner's state word at the trailing edge: the row then says where the work stands once. */
  trailingState?: Readonly<{ word: string; tone: HappierWorkStatusTone }> | null;
  accessibilityLabel: string;
  accessibilityLiveRegion?: 'none' | 'polite' | 'assertive';
  /** Prefix for this instance's test ids. */
  testID?: string;
  /** `pane` (default) or `page`: see {@link HappierWorkRowDensity}. Match the row shell's density. */
  density?: HappierWorkRowDensity;
  /**
   * Whether `attention` puts an amber dot in the mark's corner (default). A list whose every row needs
   * the person (the Inbox) already says so by being that list; its rows keep the strong title and
   * their state word, and leave the corner quiet.
   */
  attentionMark?: boolean;
  /**
   * How many lines the title may take (default 1). A phone's page row lets a long title wrap onto a
   * second line rather than cut the words that tell it from its siblings (lab `phone-P4`).
   */
  titleLines?: 1 | 2;
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
  const titleTailStart = props.titleTailStart ?? 0;
  const titleHead = titleTailStart > 0 ? props.title.slice(0, titleTailStart).trimEnd() : '';
  const titleTail = titleHead.length > 0 ? props.title.slice(titleTailStart) : '';
  const titleColor = { color: theme.colors.text };
  const density = props.density ?? 'pane';
  const roles = TEXT_ROLES[density];
  const attentionMark = props.attentionMark !== false;
  const titleLines = props.titleLines ?? 1;

  return (
    <View testID={testID} accessible accessibilityLabel={props.accessibilityLabel} accessibilityLiveRegion={props.accessibilityLiveRegion}
      style={[styles.summary, density === 'page' ? PAGE_SUMMARY_STYLE : null]}>
      {props.mark !== null && props.mark !== undefined ? <View style={styles.mark}>
        {props.mark}
        {phase === 'attention' && attentionMark ? (
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
      </View> : null}
      <View style={styles.copy}>
        {titleTail.length > 0 ? (
          <View style={styles.splitTitle}>
            <Text
              role={roles.title}
              strong={phase === 'attention'}
              numberOfLines={1}
              testID={testID ? `${testID}:title` : undefined}
              style={[TITLE_HEAD_STYLE, titleColor]}
            >
              {titleHead}
            </Text>
            <Text
              role={roles.title}
              strong={phase === 'attention'}
              numberOfLines={1}
              testID={testID ? `${testID}:title-tail` : undefined}
              style={[TITLE_TAIL_STYLE, titleColor]}
            >
              {NON_BREAKING_SPACE}
              {titleTail}
            </Text>
          </View>
        ) : (
          <Text role={roles.title} strong={phase === 'attention'} numberOfLines={titleLines}
            testID={testID ? `${testID}:title` : undefined} style={titleColor}>
            {props.title}
          </Text>
        )}
        {props.facts.length > 0 ? (
          <HappierFactLine
            role={roles.line}
            testID={testID ? `${testID}:facts` : undefined}
            numberOfLines={1}
            style={[LINE_STYLE, { color: theme.colors.secondaryText }]}
            facts={props.facts}
            theme={theme}
            host={host}
          />
        ) : null}
        {props.byline ? (
          <View style={BYLINE_STYLE} testID={testID ? `${testID}:byline` : undefined}>
            {props.byline.leading ?? null}
            <Text role={roles.line} numberOfLines={1} style={[BYLINE_TEXT_STYLE, { color: theme.colors.mutedText }]}>{props.byline.text}</Text>
          </View>
        ) : null}
      </View>
      {trailingTime ? (
        <Text role={roles.time} style={[TIME_STYLE, { color: theme.colors.mutedText }]}>{trailingTime}</Text>
      ) : null}
      {trailingState ? (
        <HappierWorkStatusWord
          role={roles.state}
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
