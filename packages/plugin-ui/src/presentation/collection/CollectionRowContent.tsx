import type { ReactElement, ReactNode } from 'react';
import {
  Platform,
  View,
  type ViewStyle,
} from 'react-native';

import type {
  HappierAccessibilityRole,
  HappierAccessibilityState,
  HappierGestureResponderEvent,
  HappierLayoutChangeEvent,
  HappierPortableStyle,
  HappierStyleProp,
  HappierTextHostProps,
} from '../portableTypes.js';
import {
  resolveHappierTypeScale,
  type HappierTypeRole,
} from '../text/typeScale.js';
import { HAPPIER_COLLECTION_LIST_METRICS } from './CollectionList.js';
import { HAPPIER_PAGE_METRICS } from '../layout/pageMetrics.js';
import { useHappierMaterialColorResolver } from '../layout/Surface.js';

/**
 * A work row's content on a collection's plane (lab `clflat`): identity, title with its quiet context, and one
 * status slot at the end. Sessions, Runs, scheduled work and plugin work lists draw the same anatomy at one of
 * three densities; navigation, selection, gestures and menus stay with the row's owner (List.Item, a
 * Session row), which wraps this leaf through `renderContainer`.
 *
 * The row lies flat: no sheet, border or shadow. The open row's fill and the pointer's hover are the only
 * surfaces it takes, in the list's row shape, from the colours its host supplies.
 */
export type HappierCollectionRowDensity =
  | 'compact'
  | 'comfortable'
  | 'detailed';

const CONTENT_PADDING_PX =
  HAPPIER_COLLECTION_LIST_METRICS.contentInset -
  HAPPIER_COLLECTION_LIST_METRICS.rowInset;

/**
 * The one geometry owner of collection work rows. Compact is the dense pointer row (32, lab `clflat`); a
 * touch-first compact row (`touchCompact`) is the phone's flat list row: its row-title line in the same breathing
 * room, so it is only as tall as that line needs — never the finger's target, whose hit area reaches past the drawn
 * row invisibly (owner 11-10). Text scaling may grow a row.
 */
export const HAPPIER_COLLECTION_ROW_METRICS = Object.freeze({
  height: Object.freeze({
    compact: 32,
    comfortable: 58,
    detailed: 84,
    // The phone's flat row: its title line with a little air, closer than a sheet row (owner 1250 #03: too spread).
    touchCompact: 32,
  }),
  /** The leading identity column and the mark inside it. */
  identity: Object.freeze({
    compact: Object.freeze({ slotSize: 16, markSize: 15 }),
    comfortable: Object.freeze({ slotSize: 30, markSize: 23 }),
    detailed: Object.freeze({ slotSize: 48, markSize: 37 }),
    // A phone row's identity column is the page row's leading column, so its title shares one edge with group
    // labels, navigation rows and sheet rows (owner 1250 #05: one icon column, one icon→text gap).
    touchCompact: Object.freeze({ slotSize: HAPPIER_PAGE_METRICS.rowLeadingColumnPx, markSize: 16 }),
  }),
  /** The row's own horizontal padding, inside the column gutter; compact lands its glyph on the text edge. */
  padding: Object.freeze({
    compact: CONTENT_PADDING_PX,
    comfortable: CONTENT_PADDING_PX,
    detailed: 16,
  }),
  /** Identity column → title. */
  contentGap: Object.freeze({
    compact: HAPPIER_COLLECTION_LIST_METRICS.rowGlyphGap,
    comfortable: 12,
    detailed: 14,
  }),
  titleGap: 6,
  trailingGap: 8,
  /** The status slot yields before the title does, so two rows never collapse to the same clipped title. */
  trailingMaxShare: 0.4,
  /** A status glyph stays legible when its word yields to the title. */
  trailingMinPx: 16,
  /** The status slot's glyph column (lab `clstatus`). */
  statusSlotPx: 14,
  /** A row action's drawn square and the gap between actions (the hover actions at the row's end). */
  actionPx: 24,
  actionGap: 2,
  /** Where the row's actions stand over the title's tail on the web, the title fades out over this far. */
  actionFadePx: 12,
  radius: HAPPIER_COLLECTION_LIST_METRICS.rowRadius,
});

const TITLE_ROLES: Readonly<
  Record<HappierCollectionRowDensity | 'touchCompact', HappierTypeRole>
> = Object.freeze({
  detailed: 'label',
  comfortable: 'label',
  compact: 'body',
  touchCompact: 'label',
});
const LINE_ROLES: Readonly<
  Record<HappierCollectionRowDensity, HappierTypeRole>
> = Object.freeze({
  detailed: 'meta',
  comfortable: 'micro',
  compact: 'micro',
});

export type HappierCollectionRowTextMetrics = Readonly<{
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
}>;

function roleMetrics(
  role: HappierTypeRole,
  platform: string,
): HappierCollectionRowTextMetrics {
  const step = resolveHappierTypeScale(role, platform);
  return {
    fontSize: step.fontSize,
    lineHeight: step.lineHeight,
    letterSpacing: step.letterSpacing,
  };
}

/** The title's size at a density (weight and face stay the host text owner's). */
export function resolveHappierCollectionRowTitleMetrics(
  density: HappierCollectionRowDensity,
  platform: string,
  touchCompact = false,
): HappierCollectionRowTextMetrics {
  return roleMetrics(
    TITLE_ROLES[
      density === 'compact' && touchCompact ? 'touchCompact' : density
    ],
    platform,
  );
}

/** The quiet line's (and status word's) size at a density; a touch compact row keeps it readable (meta). */
export function resolveHappierCollectionRowLineMetrics(
  density: HappierCollectionRowDensity,
  platform: string,
  touchCompact = false,
): HappierCollectionRowTextMetrics {
  return roleMetrics(
    density === 'compact' && touchCompact ? 'meta' : LINE_ROLES[density],
    platform,
  );
}

export function resolveHappierCollectionRowIdentityMetrics(
  density: HappierCollectionRowDensity,
  touchCompact = false,
): Readonly<{ slotSize: number; markSize: number }> {
  return density === 'compact' && touchCompact
    ? HAPPIER_COLLECTION_ROW_METRICS.identity.touchCompact
    : HAPPIER_COLLECTION_ROW_METRICS.identity[density];
}

export function resolveHappierCollectionRowHeight(
  density: HappierCollectionRowDensity,
  touchCompact = false,
): number {
  return density === 'compact' && touchCompact
    ? HAPPIER_COLLECTION_ROW_METRICS.height.touchCompact
    : HAPPIER_COLLECTION_ROW_METRICS.height[density];
}

export type HappierCollectionRowContentProps = Readonly<{
  density: HappierCollectionRowDensity;
  /** A compact row drawn for a finger (a phone): the readable touch height and mark. */
  touchCompact?: boolean;
  /** The host's text scale; above 1.1 the row may grow instead of clipping. */
  textScale?: number;
  selected?: boolean;
  /** The pointer rests on the row (fine pointers only; the row's owner tracks it). */
  hovered?: boolean;
  /** The host's fills for the open row and the pointer's hover, on the plane under the row. */
  fills: Readonly<{ selected: string; hover: string }>;
  /** A hairline under the row, for a row embedded in a card that separates its rows. */
  separator?: Readonly<{ color: string }> | null;
  /** Independent leading controls, outside navigation (the reports disclosure, a depth gutter). */
  leading?: ReactNode;
  identity?: ReactNode;
  /** The title line: the title, then its quiet context and qualifiers. */
  title: ReactNode;
  /** Lines under the title (comfortable and detailed rows). */
  children?: ReactNode;
  /** The status slot and any independent controls at the row's end; never a child of the press target. */
  trailing?: ReactNode;
  /**
   * The trailing slot moves beneath the text, onto the title's edge, and the row grows to hold it: a narrow page row
   * whose status would otherwise squeeze the title below its label column (the page row rule,
   * `isHappierPageRowAccessoryStacked`, which the row's owner measures and decides).
   */
  trailingBeneath?: boolean;
  trailingProps?: Pick<HappierTextHostProps,
    | 'accessible' | 'accessibilityLabel' | 'accessibilityHint'
    | 'accessibilityElementsHidden' | 'accessibilityLiveRegion'
    | 'importantForAccessibility' | 'nativeID' | 'onLayout' | 'testID'
  > & Readonly<{
    accessibilityRole?: HappierAccessibilityRole;
    accessibilityState?: HappierAccessibilityState;
    onPointerEnter?(event: HappierGestureResponderEvent): void;
    onPointerLeave?(event: HappierGestureResponderEvent): void;
  }>;
  /**
   * While the row is engaged (pointer on it, keyboard focus inside it, one of its menus open): its actions. They
   * replace the resting trailing content at the row's far end, standing over the title's tail, which fades out
   * under them on the web. The resting content keeps its box, hidden, so the title never reflows (owner
   * 2026-11-11). `actionCount` sizes the band from the shared action metrics.
   */
  engagedTrailing?: Readonly<{ node: ReactNode; actionCount: number }> | null;
  /**
   * The row's owner supplies its press target around the identity and text (a Pressable, a link); static
   * previews omit it. The trailing slot stays its sibling: on the web a button renders a `<button>`, and the
   * trailing controls are buttons of their own.
   */
  renderContainer?: (content: ReactNode, style: typeof pressTarget) => ReactElement;
  /** Measures the whole row, the trailing slot included. */
  onLayout?(event: HappierLayoutChangeEvent): void;
  style?: HappierStyleProp;
}>;

const M = HAPPIER_COLLECTION_ROW_METRICS;
const rowBase: ViewStyle = {
  flexDirection: 'row',
  alignItems: 'center',
  borderRadius: M.radius,
};
const identityBase: ViewStyle = {
  position: 'relative',
  alignItems: 'center',
  justifyContent: 'center',
};
const contentBase: ViewStyle = {
  flex: 1,
  justifyContent: 'center',
  minWidth: 0,
};
const titleRow: ViewStyle = {
  flexDirection: 'row',
  alignItems: 'center',
  marginBottom: 1,
  gap: M.titleGap,
  minWidth: 0,
};
const trailingBase: ViewStyle = {
  marginLeft: M.trailingGap,
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'flex-end',
  flexShrink: 1,
  minWidth: 0,
  maxWidth: `${M.trailingMaxShare * 100}%`,
  // The row's height, so the engaged actions centre on the row wherever the resting content sits.
  alignSelf: 'stretch',
};
/** Beneath the text: its own line on the title's edge, as wide as it needs. */
const trailingBeneathBase: ViewStyle = {
  flexDirection: 'row',
  alignItems: 'center',
  alignSelf: 'flex-start',
  maxWidth: '100%',
  minWidth: 0,
  marginTop: M.titleGap,
};
const beneathLine: ViewStyle = { flexDirection: 'row', alignItems: 'center', minWidth: 0 };
const restingTrailing: ViewStyle = {
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'flex-end',
  flexShrink: 1,
  minWidth: 0,
};
const restingTrailingHidden: ViewStyle = { ...restingTrailing, opacity: 0 };
const engagedTrailingBand: ViewStyle = {
  position: 'absolute',
  right: 0,
  top: 0,
  bottom: 0,
  flexDirection: 'row',
  alignItems: 'center',
  gap: M.actionGap,
};

/** The width of `count` row actions side by side. */
function resolveActionBandPx(count: number): number {
  return count <= 0 ? 0 : count * M.actionPx + (count - 1) * M.actionGap;
}

/**
 * On the web the press target's end fades out under the engaged actions (a fade, not a painted backdrop: a
 * glass row's translucent fill would let the title show through a backdrop). The band begins past the trailing
 * gap and the status slot it covers.
 */
function engagedPressTargetStyle(actionCount: number): typeof pressTarget {
  const covered = Math.max(0, resolveActionBandPx(actionCount) - M.statusSlotPx - M.trailingGap);
  const mask = `linear-gradient(to left, transparent ${covered}px, #000 ${covered + M.actionFadePx}px)`;
  const style = { ...pressTarget, maskImage: mask, WebkitMaskImage: mask };
  return style;
}
const pressTarget = {
  flex: 1,
  minWidth: 0,
  alignSelf: 'stretch',
  flexDirection: 'row',
  alignItems: 'center',
} satisfies HappierPortableStyle;

export type HappierCollectionRowMainProps = Readonly<{
  density: HappierCollectionRowDensity;
  touchCompact?: boolean;
  identity?: ReactNode;
  /**
   * `page`: a row on a page sheet (the Inbox's Work rows) takes the page row's leading column and gap, so its
   * title shares the sheet's one edge (phone 68) with every `Item` row; the mark sits centred on the glyph axis.
   */
  identityColumn?: 'density' | 'page';
  /** The title line: the title, then its quiet context and qualifiers. */
  title: ReactNode;
  /** Lines under the title. */
  children?: ReactNode;
  /**
   * The text column runs under the identity at the row's full width instead of beside it (a narrow row at a
   * large text size, where the column beside the mark could not hold a name). The parent lays the row out as a column.
   */
  stacked?: boolean;
}>;

/** A stacked row's text under its identity: the full width, one title gap below the mark. */
const STACKED_CONTENT_STYLE = { flex: 0, alignSelf: 'stretch', marginTop: M.titleGap } as const;

const PAGE_IDENTITY_COLUMN_STYLE = {
  width: HAPPIER_PAGE_METRICS.rowLeadingColumnPx,
  height: HAPPIER_COLLECTION_ROW_METRICS.identity.comfortable.slotSize,
} as const;
const PAGE_CONTENT_GAP_STYLE = { marginLeft: HAPPIER_PAGE_METRICS.rowLeadingGapPx } as const;

/**
 * The slot layout every work row shares: the identity column at the density's size, then the text column
 * (the title line, then the lines under it) after the density's gap. {@link HappierCollectionRowContent}
 * frames it as a collection row; a Work summary (`HappierWorkSummary`) sets it inside its own row shell.
 * It brings no frame, press target or alignment of its own; its parent row decides those.
 */
export function HappierCollectionRowMain(
  props: HappierCollectionRowMainProps,
): ReactElement {
  const touchCompact =
    props.touchCompact === true && props.density === 'compact';
  const identity = resolveHappierCollectionRowIdentityMetrics(
    props.density,
    touchCompact,
  );
  const page = props.identityColumn === 'page';
  return (
    <>
      {props.identity != null ? (
        <View
          style={[
            identityBase,
            page ? PAGE_IDENTITY_COLUMN_STYLE : { width: identity.slotSize, height: identity.slotSize },
          ]}
        >
          {props.identity}
        </View>
      ) : null}
      <View
        style={[
          contentBase,
          props.stacked === true ? STACKED_CONTENT_STYLE
            : props.identity != null
              ? page ? PAGE_CONTENT_GAP_STYLE : { marginLeft: M.contentGap[props.density] }
              : null,
        ]}
      >
        <View style={titleRow}>{props.title}</View>
        {props.children}
      </View>
    </>
  );
}

export function HappierCollectionRowContent(
  props: HappierCollectionRowContentProps,
): ReactElement {
  const touchCompact =
    props.touchCompact === true && props.density === 'compact';
  const height = resolveHappierCollectionRowHeight(props.density, touchCompact);
  const textScale =
    typeof props.textScale === 'number' && Number.isFinite(props.textScale)
      ? Math.max(1, props.textScale)
      : 1;
  const beneath = props.trailingBeneath === true;
  const grows = textScale > 1.1 || beneath;
  // Fills resolve through the plane's material, so a glass sidebar keeps its coat under the row's chip.
  const paintColor = useHappierMaterialColorResolver();
  const fill =
    props.selected === true
      ? props.fills.selected
      : props.hovered === true
        ? props.fills.hover
        : undefined;
  const rowStyle = [
    rowBase,
    { paddingHorizontal: M.padding[props.density] },
    grows
      ? { minHeight: Math.ceil(height * Math.min(textScale, 2.5)) }
      : { height },
    beneath
      ? { flexDirection: 'column', alignItems: 'stretch', justifyContent: 'center', paddingVertical: M.padding[props.density] } as const
      : null,
    fill ? { backgroundColor: paintColor(fill) } : null,
    props.separator
      ? { borderBottomWidth: 1, borderBottomColor: props.separator.color }
      : null,
    props.style,
  ];
  const content = (
    <HappierCollectionRowMain
      density={props.density}
      touchCompact={touchCompact}
      identity={props.identity}
      title={props.title}
    >
      {props.children}
    </HappierCollectionRowMain>
  );
  const engaged = props.engagedTrailing ?? null;
  const containerStyle = engaged && !beneath && Platform.OS === 'web' ? engagedPressTargetStyle(engaged.actionCount) : pressTarget;
  const restingTestID = props.trailingProps?.testID ? `${props.trailingProps.testID}:rest` : undefined;
  const main = props.renderContainer
    ? props.renderContainer(content, containerStyle)
    : content;
  // Beneath, the slot starts where the title does: past the identity column, when there is one.
  const titleEdge = props.identity != null
    ? resolveHappierCollectionRowIdentityMetrics(props.density, touchCompact).slotSize + M.contentGap[props.density]
    : 0;
  return (
    <View style={rowStyle} onLayout={props.onLayout}>
      {beneath ? <View style={beneathLine}>{props.leading}{main}</View> : <>{props.leading}{main}</>}
      <View {...props.trailingProps} style={beneath ? [trailingBeneathBase, { marginLeft: titleEdge }] : trailingBase}>
        <View
          testID={restingTestID}
          style={engaged ? restingTrailingHidden : restingTrailing}
          aria-hidden={engaged ? true : undefined}
          accessibilityElementsHidden={engaged ? true : undefined}
          importantForAccessibility={engaged ? 'no-hide-descendants' : undefined}
        >
          {props.trailing}
        </View>
        {engaged ? <View style={engagedTrailingBand}>{engaged.node}</View> : null}
      </View>
    </View>
  );
}
