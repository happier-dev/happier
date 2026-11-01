import { isValidElement, useContext, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { HAPPIER_PAGE_METRICS } from '../layout/pageMetrics.js';
import { useHappierPageSection } from '../layout/PageSection.js';
import { HappierBodyEdgeContext, useHappierColumnEdgePx } from '../layout/columnEdge.js';
import { HAPPIER_COLLECTION_LIST_METRICS } from '../collection/CollectionList.js';
import { HappierText } from '../text/Text.js';
import { HAPPIER_BALANCED_TEXT_WRAP } from '../text/balancedTextWrap.js';
import type { HappierTone } from '../semantics.js';
import { HappierDisclosureToggle } from '../collection/DisclosureToggle.js';
import { HAPPIER_MENU_ROW_METRICS } from '../interaction/Menu.js';

export type HappierSurfaceStateKind = 'empty' | 'loading' | 'success' | 'error' | 'warning' | 'unavailable' | 'denied';

/** Failure kind and layout select one semantic glyph, resolved by the icon adapter. */
export function resolveHappierStateFailureGlyph(kind: HappierSurfaceStateKind, line = false) {
  if (kind === 'error') return line ? 'warning' as const : 'failure' as const;
  if (kind === 'unavailable') return 'unavailable' as const;
  if (kind === 'denied') return 'denied' as const;
  return undefined;
}

/** Static cards stay quiet; the lifecycle caller owns the urgency of a transition. */
export function resolveHappierStateAnnouncement(semantics?: 'status' | 'alert') {
  return {
    accessibilityRole: semantics === 'alert' ? 'alert' as const : semantics === 'status' ? 'text' as const : undefined,
    accessibilityLiveRegion: semantics === 'alert' ? 'assertive' as const : semantics === 'status' ? 'polite' as const : undefined,
    role: semantics,
    'aria-live': semantics === 'alert' ? 'assertive' as const : semantics === 'status' ? 'polite' as const : undefined,
  };
}

/** The container owns placement; adapters supply themed content, never a second frame. */
export function HappierSurfaceStateFrame(props: Readonly<{
  size?: HappierStateSize;
  testID?: string;
  accessibilitySemantics?: 'status' | 'alert';
  children: ReactNode;
}>) {
  const metrics = props.size ? HAPPIER_STATE_SIZE_METRICS[props.size] : null;
  return (
    <View testID={props.testID} {...resolveHappierStateAnnouncement(props.accessibilitySemantics)} style={metrics
      ? { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, paddingTop: 24, paddingBottom: 24 + metrics.liftPx }
      : { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <View testID={props.testID ? `${props.testID}-card` : undefined} style={metrics
        ? { width: '100%', alignItems: 'center', maxWidth: metrics.measurePx }
        : { maxWidth: 560, alignSelf: 'center', padding: 24 }}>
        {props.children}
      </View>
    </View>
  );
}

/**
 * The room a line's sentence asks for before its recovery moves under it: enough for a short cause on
 * one or two lines, so a Small widget card keeps "Couldn't read this machine · Retry" one block.
 */
const LINE_TEXT_BASIS_PX = 180;

/**
 * The one in-list state line (lab 0 "N"): one compact sentence, glyph and inline recovery; diagnostic
 * detail never enters a list line. Happier core's `EmptyState layout="line"` and the plugin line states
 * both draw this, binding only their own text and glyphs. The glyph keeps the size its binding gives it:
 * a line's quiet ring or warning never grows into a row glyph.
 */
export function HappierStateLine(props: Readonly<{
  testID?: string;
  icon?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  accessibilitySemantics?: 'status' | 'alert';
  /**
   * `menu`: the line sits among a transient menu's rows, so it takes the menu row's height, inset and
   * glyph column, and its sentence starts on the options' label edge.
   */
  density?: 'menu';
}>) {
  const metrics = HAPPIER_STATE_LINE_METRICS;
  const menu = props.density === 'menu';
  // In a page section's sheet the line stands on the rows' edge (the sheet's row inset), not the
  // collection column's text inset.
  const pageSection = useHappierPageSection();
  // Loose in a page or detail column (no sheet around it) it stands on the column's text edge, under the
  // titles, rather than the collection's inset.
  const columnEdgePx = useHappierColumnEdgePx();
  // In a body that draws its own content edge (a widget body) the line stands on that edge.
  const onBodyEdge = useContext(HappierBodyEdgeContext);
  // The glyph sits in the leading column of the rows around it, so the sentence starts on their titles'
  // edge: a menu's icon box, a page section's leading column, or a collection row's glyph box.
  const glyphColumn = menu
    ? { boxPx: HAPPIER_MENU_ROW_METRICS.iconBoxSizePx, gapPx: HAPPIER_MENU_ROW_METRICS.iconMarginRightPx }
    : pageSection
      ? { boxPx: HAPPIER_PAGE_METRICS.rowLeadingColumnPx, gapPx: HAPPIER_PAGE_METRICS.rowLeadingGapPx }
      : { boxPx: HAPPIER_COLLECTION_LIST_METRICS.rowGlyphBox, gapPx: HAPPIER_COLLECTION_LIST_METRICS.rowGlyphGap };
  return (
    <View testID={props.testID} {...resolveHappierStateAnnouncement(props.accessibilitySemantics)} style={{
      minHeight: menu ? HAPPIER_MENU_ROW_METRICS.minHeightPx : metrics.minHeightPx,
      paddingHorizontal: menu
        ? HAPPIER_MENU_ROW_METRICS.paddingHorizontalPx
        : onBodyEdge
          ? 0
          : pageSection?.rowInsetPx
          ?? (columnEdgePx > 0 ? Math.max(0, HAPPIER_PAGE_METRICS.pageTextInsetPx - columnEdgePx) : metrics.paddingHorizontalPx),
      paddingVertical: metrics.paddingVerticalPx,
      // One line that wraps its sentence, never its parts: the glyph and the recovery stay beside the
      // text in a narrow column instead of stacking above and below it.
      flexDirection: 'row',
      // A sentence that needs more than the room beside its glyph puts the recovery under it, instead of
      // wrapping the sentence to four lines in a column left by the recovery.
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: metrics.gapPx,
    }}>
      {/* The glyph and its sentence wrap as one unit, so a narrow column never leaves the glyph alone above the text. */}
      <View style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: glyphColumn.gapPx,
        flexShrink: 1,
        minWidth: 0,
        ...(props.action ? { flexGrow: 1, flexBasis: LINE_TEXT_BASIS_PX } : {}),
      }}>
        {props.icon ? <View style={{ flexShrink: 0, width: glyphColumn.boxPx, alignItems: 'center' }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{props.icon}</View> : null}
        <View style={{ flexShrink: 1, minWidth: 0 }}>{props.children}</View>
      </View>
      {props.action ? <View style={{ flexShrink: 0, marginLeft: 'auto' }}>{props.action}</View> : null}
    </View>
  );
}

/** Disclosure lifetime and keyboard semantics are shared; text and glyphs remain host bindings. */
export function HappierStateDetails(props: Readonly<{
  testID?: string;
  markerTestID?: string;
  label: string;
  details: string;
  /** The compact caret for the open state (the host's caret, or the drawn chevron without a host). */
  renderCaret: (open: boolean) => ReactNode;
  /** The label in the host's meta text; absent, the environment's. */
  renderLabel?: (label: string) => ReactNode;
  focusColor?: string;
  renderDetails?: (details: string) => ReactNode;
  /** `start` for a state that stands on a left edge (an inline state): the disclosure joins that edge. */
  align?: 'start' | 'center';
}>) {
  const start = props.align === 'start';
  const [open, setOpen] = useState(false);
  return (
  <View testID={props.markerTestID} style={{ alignItems: start ? 'flex-start' : 'center', marginTop: start ? 4 : 12, gap: 6 }}>
    <HappierDisclosureToggle
      testID={props.testID ? `${props.testID}-details-toggle` : undefined}
      label={props.label}
      open={open}
      onPress={() => setOpen((value) => !value)}
      caret={props.renderCaret(open)}
      renderLabel={props.renderLabel}
      focusColor={props.focusColor}
      align={start ? 'start' : 'center'}
      // The action above it owns the gap between them: the toggle's own hit area never reaches back up into it.
      hitReach={{ top: 0 }}
    />
    {open ? props.renderDetails?.(props.details) ?? <HappierText testID={props.testID ? `${props.testID}-details-code` : undefined} variant="code" tone="secondary" selectable style={{ textAlign: 'center' }}>{props.details}</HappierText> : null}
  </View>
  );
}

/** Shared retained-content line; each adapter binds its palette, text and recovery control. */
export function HappierFreshnessLine(props: Readonly<{
  testID?: string;
  busy?: boolean;
  colors: Readonly<{ background: string; border: string }>;
  icon: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  /**
   * The line sits on a sheet or card that already draws the surface (a widget body): it is one plain
   * line on that sheet, aligned with its content, never a filled strip boxed inside it.
   */
  onSheet?: boolean;
  /**
   * `line` (default): the strip under a surface's header. `chip`: the same facts as one inline status at a
   * header's or tab bar's end ("● Live", "As of 10:42 · Retry"), sized to its words, with no strip.
   */
  presentation?: 'line' | 'chip';
  /** Chip only: a quiet clause before the glyph ("Sampled only while you're looking"). */
  lead?: ReactNode;
}>) {
  const metrics = HAPPIER_FRESHNESS_LINE_METRICS;
  const chip = props.presentation === 'chip';
  const plain = chip || props.onSheet === true;
  return (
    <View testID={props.testID} accessibilityRole="text" accessibilityLiveRegion="polite" role="status" aria-live="polite" aria-busy={props.busy || undefined} style={{
      flexDirection: 'row',
      alignItems: 'center',
      gap: chip ? metrics.chip.gapPx : metrics.gapPx,
      minHeight: chip ? metrics.chip.minHeightPx : metrics.minHeightPx,
      flexShrink: chip ? 1 : undefined,
      minWidth: chip ? 0 : undefined,
      paddingLeft: plain ? 0 : metrics.paddingStartPx,
      paddingRight: plain ? 0 : metrics.paddingEndPx,
      paddingVertical: chip ? 0 : metrics.paddingVerticalPx,
      backgroundColor: plain ? 'transparent' : props.colors.background,
      borderTopWidth: plain ? 0 : StyleSheet.hairlineWidth,
      borderBottomWidth: plain ? 0 : StyleSheet.hairlineWidth,
      borderColor: props.colors.border,
      // A line whose recoveries no longer fit beside its words moves them beneath (time over reason over
      // actions), never squeezing the sentence to an ellipsis.
      flexWrap: chip ? undefined : 'wrap',
    }}>
      {chip ? props.lead ?? null : null}
      {chip ? (
        <>
          {props.icon}
          <View style={{ flexShrink: 1, minWidth: 0 }}>{props.children}</View>
          {props.action ?? null}
        </>
      ) : (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: metrics.gapPx, flexGrow: 1, flexShrink: 1, minWidth: 0,
            flexBasis: props.action ? LINE_TEXT_BASIS_PX : 'auto' }}>
            {props.icon}
            <View style={{ flex: 1, minWidth: 0 }}>{props.children}</View>
          </View>
          {props.action ? <View style={{ flexShrink: 0, marginLeft: 'auto' }}>{props.action}</View> : null}
        </>
      )}
    </View>
  );
}

/**
 * The words of a freshness line as two clauses (L4, FB1o): "As of 14:02 · MacBook Pro isn't answering"
 * on one line when both fit, otherwise the time over the reason. The dot belongs to the line, not to the
 * reason: it rides the end of the first clause and is not drawn once the reason starts a line of its own
 * (it keeps its width, so hiding it never re-flows the clauses). Each realm binds its own text.
 */
export function HappierFreshnessClauses(props: Readonly<{
  asOf: ReactNode | null;
  reason: ReactNode | null;
  separator: (hidden: boolean) => ReactNode;
}>) {
  const [stacked, setStacked] = useState(false);
  const tops = useRef<{ first: number | null; reason: number | null }>({ first: null, reason: null });
  const measure = (clause: 'first' | 'reason', y: number) => {
    tops.current[clause] = y;
    const { first, reason } = tops.current;
    if (first === null || reason === null) return;
    const next = reason > first + 1;
    setStacked((current) => current === next ? current : next);
  };
  if (props.asOf === null || props.reason === null) return <>{props.asOf ?? props.reason}</>;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', minWidth: 0 }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', flexShrink: 0 }}
        onLayout={(event) => measure('first', event.nativeEvent.layout.y)}>
        {props.asOf}
        {props.separator(stacked)}
      </View>
      <View style={{ flexShrink: 1, minWidth: 0 }} onLayout={(event) => measure('reason', event.nativeEvent.layout.y)}>
        {props.reason}
      </View>
    </View>
  );
}

/**
 * The single implementation owner for Happier's centered informational state
 * (UI-T27) — the shape behind "nothing here yet", "still loading" and "that
 * failed".
 *
 * Extracted from `apps/ui/sources/components/ui/lists/CenteredInfoTile.tsx` and
 * `apps/ui/sources/components/ui/empty/EmptyState.tsx`, whose measured layout it
 * preserves exactly: the full-width centered column, the 32/16 padding pair, the
 * 520pt readable measure, and the action slot's 16pt offset.
 *
 * **Typography stays with its owner.** A slot given a rendered element is
 * rendered as-is, so Happier core keeps supplying Unistyles typography through
 * its own `Text` adapter — which is what keeps the `uiFontScale` local setting
 * applying (§3.10.8). A slot given a plain string is rendered through the shared
 * {@link HappierText} against the environment theme, which is what a plugin
 * surface — with no Unistyles — needs.
 */
const INFO_STATE_MEASURE = 520;
const INFO_STATE_VERTICAL_PADDING = 32;
const INFO_STATE_HORIZONTAL_PADDING = 16;
const INFO_STATE_TITLE_GAP = 6;
const INFO_STATE_ACTION_GAP = 16;

/**
 * The container a state sits in (pane-states lab 0). One composition, stepped by container so every
 * surface stops hand-sizing its states:
 *
 * - `pane`: the 340 right-sidebar pane — measure 272, centred a little above the middle.
 * - `details`: the details drawer — measure 380, one step larger.
 * - `page`: an app page's content column — measure 440, larger glyph and title.
 * - `phone`: a phone pane or pushed route — measure 320, larger copy, full-width actions.
 *
 * `undefined` keeps the legacy centred column (520 measure) for consumers outside a sized container.
 */
export type HappierStateSize = 'pane' | 'details' | 'page' | 'phone';

type HappierStateSizeMetrics = Readonly<{
  /** Readable measure of the title and copy. */
  measurePx: number;
  glyphPx: number;
  /** Space between the glyph and the title. */
  glyphGapPx: number;
  title: Readonly<{ fontSize: number; lineHeight: number }>;
  body: Readonly<{ fontSize: number; lineHeight: number }>;
  /** Space between the title and the copy. */
  bodyGapPx: number;
  /** Space between the copy and the actions. */
  actionGapPx: number;
  /** Space above the quiet lines under the actions (How it works, a note, a live line). */
  quietGapPx: number;
  quiet: Readonly<{ fontSize: number; lineHeight: number }>;
  /** Extra room under the state so it sits a little above the container's middle. */
  liftPx: number;
  /** Phones stretch the actions to the column's width. */
  fullWidthActions: boolean;
}>;

export const HAPPIER_STATE_SIZE_METRICS: Readonly<Record<HappierStateSize, HappierStateSizeMetrics>> = Object.freeze({
  pane: Object.freeze({
    measurePx: 272,
    glyphPx: 26,
    glyphGapPx: 14,
    title: Object.freeze({ fontSize: 15, lineHeight: 20 }),
    body: Object.freeze({ fontSize: 13, lineHeight: 19 }),
    bodyGapPx: 5,
    actionGapPx: 16,
    quietGapPx: 12,
    quiet: Object.freeze({ fontSize: 12, lineHeight: 17 }),
    liftPx: 40,
    fullWidthActions: false,
  }),
  details: Object.freeze({
    measurePx: 380,
    glyphPx: 26,
    glyphGapPx: 14,
    title: Object.freeze({ fontSize: 17, lineHeight: 22 }),
    body: Object.freeze({ fontSize: 13.5, lineHeight: 20 }),
    bodyGapPx: 5,
    actionGapPx: 16,
    quietGapPx: 12,
    quiet: Object.freeze({ fontSize: 12, lineHeight: 17 }),
    liftPx: 40,
    fullWidthActions: false,
  }),
  page: Object.freeze({
    measurePx: 440,
    glyphPx: 30,
    glyphGapPx: 18,
    title: Object.freeze({ fontSize: 20, lineHeight: 26 }),
    body: Object.freeze({ fontSize: 14, lineHeight: 21 }),
    bodyGapPx: 7,
    actionGapPx: 20,
    quietGapPx: 12,
    quiet: Object.freeze({ fontSize: 12, lineHeight: 17 }),
    liftPx: 96,
    fullWidthActions: false,
  }),
  phone: Object.freeze({
    measurePx: 320,
    glyphPx: 28,
    glyphGapPx: 14,
    title: Object.freeze({ fontSize: 19, lineHeight: 25 }),
    body: Object.freeze({ fontSize: 15, lineHeight: 21 }),
    bodyGapPx: 6,
    actionGapPx: 20,
    quietGapPx: 12,
    quiet: Object.freeze({ fontSize: 13, lineHeight: 18 }),
    liftPx: 40,
    fullWidthActions: true,
  }),
});

/**
 * The freshness line of stale content (pane-states lab 0, "Stale"): last-known content stays at full
 * strength and one quiet line under the header says as of when, why, and offers Retry. It never sits
 * over an empty body — a surface that never loaded is loading or failed, not stale.
 */
export const HAPPIER_FRESHNESS_LINE_METRICS = Object.freeze({
  minHeightPx: 32,
  paddingStartPx: 16,
  paddingEndPx: 12,
  /** Block padding: a stacked line keeps air above and below; one line still makes the 32 pt minimum. */
  paddingVerticalPx: 6,
  gapPx: 8,
  glyphPx: 13,
  text: Object.freeze({ fontSize: 12, lineHeight: 16 }),
  /** The inline chip (resources lab `.rs-live`): a 6 pt dot or the 13 pt glyph, then the words, 6 pt apart. */
  chip: Object.freeze({ minHeightPx: 24, gapPx: 6, dotPx: 6 }),
});

/**
 * The in-list line (lab 0, "N"): one quiet line on the rows' edge — glyph, one sentence, an inline
 * link. A section keeps its title and this line; it is never removed because it is empty or failed.
 */
export const HAPPIER_STATE_LINE_METRICS = Object.freeze({
  minHeightPx: 32,
  paddingHorizontalPx: HAPPIER_COLLECTION_LIST_METRICS.contentInset,
  paddingVerticalPx: 7,
  gapPx: 8,
  glyphPx: 14,
  text: Object.freeze({ fontSize: 12.5, lineHeight: 17 }),
});

export type HappierInfoTileProps = Readonly<{
  /** Leading glyph, already themed by the caller. */
  icon?: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  /** Semantic colour for string slots. Ignored for slots the caller renders itself. */
  tone?: HappierTone;
  paddingHorizontal?: number;
  /** Overrides the column's vertical padding (a framed page state supplies its own). */
  paddingVertical?: number;
  /** The container's size step; sets the readable measure. */
  size?: HappierStateSize;
}>;

export type HappierInfoStateProps = Readonly<{
  /** The informational body — normally a {@link HappierInfoTile}. */
  children?: ReactNode;
  /** Call-to-action rendered below the body. */
  action?: ReactNode;
  testID?: string;
  actionTestID?: string;
  accessibilityRole?: 'alert';
  accessibilityLiveRegion?: 'none' | 'polite' | 'assertive';
  busy?: boolean;
  /** The container's size step; sets the measure and the action slot's offset. */
  size?: HappierStateSize;
}>;

function renderSlot(
  slot: ReactNode,
  semantic: Readonly<{
    variant: 'heading' | 'meta';
    tone: HappierTone;
    gap: number;
    /** A sized state's type step (`HAPPIER_STATE_SIZE_METRICS`); unsized keeps the variant's own. */
    type?: Readonly<{ fontSize: number; lineHeight: number }>;
  }>,
): ReactNode {
  if (slot === null || slot === undefined || slot === false || slot === '') return null;
  if (isValidElement(slot)) return slot;

  return (
    <HappierText
      variant={semantic.variant}
      tone={semantic.tone}
      style={{ textAlign: 'center', marginBottom: semantic.gap, ...semantic.type, ...HAPPIER_BALANCED_TEXT_WRAP }}
    >
      {slot}
    </HappierText>
  );
}

/**
 * The centered icon / title / description column.
 *
 * Happier core's `CenteredInfoTile` is this component; so is the body of every
 * plugin loading, empty and error state.
 */
export function HappierInfoTile({
  icon,
  title,
  description,
  tone,
  paddingHorizontal,
  paddingVertical,
  size,
}: HappierInfoTileProps) {
  const measure = size ? HAPPIER_STATE_SIZE_METRICS[size].measurePx : INFO_STATE_MEASURE;
  return (
    <View
      style={{
        width: '100%',
        alignItems: 'center',
        // A sized state is placed by its container (`SurfaceStateCard`), so it draws no padding of its own.
        paddingVertical: paddingVertical ?? (size ? 0 : INFO_STATE_VERTICAL_PADDING),
        paddingHorizontal: paddingHorizontal ?? INFO_STATE_HORIZONTAL_PADDING,
      }}
    >
      {icon}
      <View style={{ width: '100%', maxWidth: measure }}>
        {renderSlot(title, {
          variant: 'heading',
          tone: tone ?? 'neutral',
          gap: size ? HAPPIER_STATE_SIZE_METRICS[size].bodyGapPx : INFO_STATE_TITLE_GAP,
          type: size ? HAPPIER_STATE_SIZE_METRICS[size].title : undefined,
        })}
        {renderSlot(description, {
          variant: 'meta',
          tone: 'secondary',
          gap: 0,
          type: size ? HAPPIER_STATE_SIZE_METRICS[size].body : undefined,
        })}
      </View>
    </View>
  );
}

/**
 * A {@link HappierInfoTile} plus the call-to-action slot beneath it.
 *
 * Happier core's `EmptyState` is this component wrapped around
 * `CenteredInfoTile`; the plugin adapters wrap it around a `HappierInfoTile`.
 * Keeping the tile a child rather than a prop is what lets core keep its own
 * tile adapter — which six other core surfaces already render — instead of
 * acquiring a second one.
 */
export function HappierInfoState({
  children,
  action,
  testID,
  actionTestID,
  accessibilityRole,
  accessibilityLiveRegion,
  busy,
  size,
}: HappierInfoStateProps) {
  const metrics = size ? HAPPIER_STATE_SIZE_METRICS[size] : null;
  return (
    <View
      testID={testID}
      role={accessibilityRole}
      accessibilityRole={accessibilityRole}
      accessibilityLiveRegion={accessibilityLiveRegion}
      accessibilityState={busy === true ? { busy: true } : undefined}
      aria-live={accessibilityLiveRegion === 'none' ? 'off' : accessibilityLiveRegion}
      aria-busy={busy || undefined}
      style={{ width: '100%', alignItems: 'center' }}
    >
      {children}
      {action !== null && action !== undefined ? (
        <View
          testID={actionTestID}
          style={{
            width: '100%',
            maxWidth: metrics?.measurePx ?? INFO_STATE_MEASURE,
            alignItems: metrics?.fullWidthActions ? 'stretch' : 'center',
            marginTop: metrics?.actionGapPx ?? INFO_STATE_ACTION_GAP,
          }}
        >
          {action}
        </View>
      ) : null}
    </View>
  );
}

/**
 * The frames of an empty state, shared by Happier core's `EmptyState` and the
 * public plugin `EmptyState` (colours are the adapter's).
 *
 * - `page`: a whole page or pane with nothing in it sits in the content column
 *   on the sheets' edges, with room above and below, so it reads as the page's
 *   content rather than a card dropped on it.
 * - `add`: the dashed outline of an invitation to add the first item — only for
 *   adding; `pageAdd` / `centeredAdd` are its spacing in each layout.
 */
export const HAPPIER_EMPTY_STATE_FRAME = Object.freeze({
  /**
   * The page variant (lab E1): on the sheets' edges, one section gap under whatever precedes it,
   * where the first section would be — never floated in the middle of a tall page. The tile inside
   * draws no padding of its own (`pageTilePaddingVertical`); these are the state's 36 / 28 / 30.
   */
  page: Object.freeze({
    marginHorizontal: HAPPIER_PAGE_METRICS.sheetInsetPx,
    marginTop: HAPPIER_PAGE_METRICS.sectionGapPx,
    borderRadius: HAPPIER_PAGE_METRICS.sheetRadiusPx,
    paddingTop: 36,
    paddingHorizontal: 12,
    paddingBottom: 30,
  }),
  pageTilePaddingVertical: 0,
  /**
   * Only an invitation to add (`variant="add"`: "No pools yet" → New pool) draws the dashed hairline:
   * dashed means "add something here". "All caught up", informational and offline states do not.
   */
  pageAdd: Object.freeze({
    borderWidth: 1,
    borderStyle: 'dashed' as const,
  }),
  centeredAdd: Object.freeze({ paddingBottom: 24 }),
  add: Object.freeze({
    borderWidth: 1,
    borderStyle: 'dashed' as const,
    borderRadius: HAPPIER_PAGE_METRICS.sheetRadiusPx,
  }),
  /** Why the viewer cannot take the state's action, in the action's place. */
  unavailableReason: Object.freeze({
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center' as const,
    maxWidth: 360,
  }),
});
