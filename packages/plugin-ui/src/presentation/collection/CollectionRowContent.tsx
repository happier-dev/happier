import type { ReactElement, ReactNode } from 'react';
import {
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
 * touch-first compact row (`touchCompact`) is the phone's flat row (phone-system lab: 44 tall, its title in the
 * row-title role every phone row uses). Text scaling may grow a row.
 */
export const HAPPIER_COLLECTION_ROW_METRICS = Object.freeze({
  height: Object.freeze({
    compact: 32,
    comfortable: 58,
    detailed: 84,
    touchCompact: 44,
  }),
  /** The leading identity column and the mark inside it. */
  identity: Object.freeze({
    compact: Object.freeze({ slotSize: 16, markSize: 15 }),
    comfortable: Object.freeze({ slotSize: 30, markSize: 23 }),
    detailed: Object.freeze({ slotSize: 48, markSize: 37 }),
    touchCompact: Object.freeze({ slotSize: 20, markSize: 16 }),
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
};
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
   * title shares the sheet's one edge (phone 64) with every `Item` row; the mark sits centred on the glyph axis.
   */
  identityColumn?: 'density' | 'page';
  /** The title line: the title, then its quiet context and qualifiers. */
  title: ReactNode;
  /** Lines under the title. */
  children?: ReactNode;
}>;

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
          props.identity != null
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
  const grows = textScale > 1.1;
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
  return (
    <View style={rowStyle} onLayout={props.onLayout}>
      {props.leading}
      {props.renderContainer
        ? props.renderContainer(content, pressTarget)
        : content}
      <View {...props.trailingProps} style={trailingBase}>
        {props.trailing}
      </View>
    </View>
  );
}
