import { isValidElement, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { HAPPIER_PAGE_METRICS } from '../layout/pageMetrics.js';
import { HappierText } from '../text/Text.js';
import type { HappierTone } from '../semantics.js';
import { HappierPressable } from '../interaction/Pressable.js';
import { happierDiscretePressStyle, happierPressTransitionStyle } from '../interaction/pressFeedback.js';
import { useOptionalHappierUiAccessibility } from '../../environment/context.js';

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

/** One compact sentence, glyph and inline recovery; diagnostic detail never enters a list line. */
export function HappierStateLine(props: Readonly<{
  testID?: string;
  icon?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  accessibilitySemantics?: 'status' | 'alert';
}>) {
  const metrics = HAPPIER_STATE_LINE_METRICS;
  return (
    <View testID={props.testID} {...resolveHappierStateAnnouncement(props.accessibilitySemantics)} style={{
      minHeight: metrics.minHeightPx,
      paddingVertical: metrics.paddingVerticalPx,
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: metrics.gapPx,
    }}>
      {props.icon ? <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{props.icon}</View> : null}
      <View style={{ flexShrink: 1, minWidth: 0 }}>{props.children}</View>
      {props.action ?? null}
    </View>
  );
}

/** Disclosure lifetime and keyboard semantics are shared; text and glyphs remain host bindings. */
export function HappierStateDetails(props: Readonly<{
  testID?: string;
  markerTestID?: string;
  label: string;
  details: string;
  renderToggle?: (open: boolean) => ReactNode;
  renderDetails?: (details: string) => ReactNode;
}>) {
  const [open, setOpen] = useState(false);
  const reducedMotion = useOptionalHappierUiAccessibility()?.reducedMotion ?? true;
  return (
  <View testID={props.markerTestID} style={{ alignItems: 'center', marginTop: 12, gap: 6 }}>
    <HappierPressable testID={props.testID ? `${props.testID}-details-toggle` : undefined} accessibilityRole="button" accessibilityLabel={props.label} expanded={open} hitSlop={8} onPress={() => setOpen((value) => !value)} style={(state) => [
      { minHeight: 32, paddingHorizontal: 8, paddingVertical: 4, flexDirection: 'row', alignItems: 'center', gap: 4 },
      happierDiscretePressStyle(state.pressed, reducedMotion),
      happierPressTransitionStyle(state.pressed, ['transform', 'opacity'], reducedMotion),
    ]}>
      {props.renderToggle?.(open) ?? <HappierText accessible={false} variant="caption" tone="secondary">{props.label}</HappierText>}
    </HappierPressable>
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
}>) {
  const metrics = HAPPIER_FRESHNESS_LINE_METRICS;
  return (
    <View testID={props.testID} accessibilityRole="text" accessibilityLiveRegion="polite" role="status" aria-live="polite" aria-busy={props.busy || undefined} style={{
      flexDirection: 'row',
      alignItems: 'center',
      gap: metrics.gapPx,
      minHeight: metrics.minHeightPx,
      paddingLeft: metrics.paddingStartPx,
      paddingRight: metrics.paddingEndPx,
      backgroundColor: props.colors.background,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: props.colors.border,
    }}>
      {props.icon}
      <View style={{ flex: 1, minWidth: 0 }}>{props.children}</View>
      {props.action ?? null}
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
  gapPx: 8,
  glyphPx: 13,
  text: Object.freeze({ fontSize: 12, lineHeight: 16 }),
});

/**
 * The in-list line (lab 0, "N"): one quiet line on the rows' edge — glyph, one sentence, an inline
 * link. A section keeps its title and this line; it is never removed because it is empty or failed.
 */
export const HAPPIER_STATE_LINE_METRICS = Object.freeze({
  minHeightPx: 32,
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
    variant: 'title' | 'body';
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
      style={{ textAlign: 'center', marginBottom: semantic.gap, ...semantic.type }}
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
          variant: 'title',
          tone: tone ?? 'neutral',
          gap: size ? HAPPIER_STATE_SIZE_METRICS[size].bodyGapPx : INFO_STATE_TITLE_GAP,
          type: size ? HAPPIER_STATE_SIZE_METRICS[size].title : undefined,
        })}
        {renderSlot(description, {
          variant: 'body',
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
