import { HappierBodyEdgeContext } from '../layout/columnEdge.js';
import { createContext, useCallback, useContext, useId, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { hasHappierPrecisePointer } from '../interaction/precisePointer.js';
import { Platform, View, type TextStyle, type ViewStyle } from 'react-native';

import {
  resolveHappierUiPalette,
  useOptionalHappierUiAccessibility,
  useOptionalHappierUiPalette,
  useOptionalHappierUiTheme,
  useOptionalHappierUiTypography,
} from '../../environment/context.js';
import type { HappierTypeRole, HappierUiTheme, HappierUiTypography } from '../../environment/types.js';
import type {
  HappierGestureResponderEvent,
  HappierPortableStyle,
  HappierStyleProp,
} from '../portableTypes.js';
import { HappierSpinner } from '../feedback/Spinner.js';
import { happierFocusRingStyle } from '../interaction/focusVisible.js';
import { HappierPressable } from '../interaction/Pressable.js';
import { HAPPIER_PRESS_FEEDBACK_V1, happierPressTransitionStyle } from '../interaction/pressFeedback.js';
import { HAPPIER_MOTION_V1 } from '../interaction/motion.js';
import { HappierDivider } from '../content/Foundation.js';
import { HAPPIER_PAGE_METRICS, isHappierPageRowAccessoryStacked, isHappierPageRowNarrow } from '../layout/pageMetrics.js';
import type { HappierPageRowMetrics } from '../layout/pageRowMetrics.js';
import { HappierPageRowFieldLayoutContext } from '../layout/pageRowField.js';
import { resolveHappierPageRowDetailLayout } from '../layout/pageRowDetail.js';
import { HAPPIER_FIELD_BOX_METRICS } from '../form/FieldBox.js';
import { happierPageRowDividerInset, happierPageRowDividerWidth, useHappierPageSection } from '../layout/PageSection.js';
import { HAPPIER_PAGE_TEXT, resolveHappierPageTextStyle } from '../layout/pageText.js';
import { HAPPIER_TONE_COLOR_TOKEN, type HappierTone } from '../semantics.js';
import { HappierText } from '../text/Text.js';
import { HAPPIER_MIDDLE_ELLIPSIS_STYLE, splitForWebMiddleEllipsis } from '../text/middleEllipsis.js';
import { HAPPIER_META_COLUMN_STYLE } from '../text/metaColumn.js';
import { resolveHappierTypeRoleStyle } from '../text/typeRole.js';
import {
  resolveHappierItemBehavior,
  type HappierItemDensity,
  type HappierRovingCollectionItem,
} from './semantics.js';
import { useHappierItemGroupItemBehavior } from './ItemGroup.js';
import { HappierRowActionRevealSlot } from './RowActionRevealSlot.js';
import {
  HAPPIER_COLLECTION_LIST_METRICS,
  type HappierCollectionRowRole,
  HAPPIER_COLLECTION_LIST_TEXT,
  HappierListRowOpenContext,
  HappierCardSelectionRingContext,
  HappierCardActionsCornerContext,
  resolveHappierCollectionListRowPadding,
  useHappierCollectionListRow,
  useHappierCollectionTableRow,
  HappierCollectionTreeRowContext,
} from './CollectionList.js';
import { resolveHappierTextStepStyle } from '../layout/pageText.js';
import { useHappierMaterialColorResolver } from '../layout/Surface.js';

/**
 * The portable list semantics shared by Happier core, executable Plugin UI and
 * declarative presentation adapters.
 *
 * This owner intentionally handles only the structural list contract:
 * platform-recognized list/list-item roles, labelled sections and row identity.
 * The public virtualized List composes its bounded search/filter/selection
 * state around this shared row owner; product-specific actions still stay in
 * their callers. Letting either a plugin or the core reimplement the row
 * semantics would create a second owner.
 */
export type HappierListProps = Readonly<{
  children?: ReactNode;
  /** Names the collection when its visible surrounding heading is insufficient. */
  accessibilityLabel?: string;
  testID?: string;
  style?: HappierStyleProp;
}>;

export type HappierListSectionProps = Readonly<{
  children?: ReactNode;
  /** Visible and semantic group name. */
  title: string;
  /** Decorated glyphs; the immutable string remains the semantic group name. */
  titleContent?: ReactNode;
  /** A quiet, tabular count beside the title. */
  count?: number;
  /** What the group's rows share, quiet at the header's end. */
  description?: string;
  /**
   * The type role of the heading's words; a dense table's groups take `micro`, and a group drawn as a page
   * section (a page-scrolling list's groups) takes the page's section title.
   */
  titleRole?: 'label' | 'micro' | 'group' | 'section';
  /** One control at the header's end ("See all"), beside — never inside — the heading's name. */
  action?: ReactNode;
  /**
   * @internal The role of the collection whose scroller hosts this section's
   * rows as the header's SIBLINGS rather than its descendants.
   *
   * A sectioned virtualizer flattens every section into a header cell followed
   * by its row cells, so the header cannot wrap them. That leaves the header a
   * direct child of the collection element, and a collection element only
   * admits the children its role permits: a `listbox` owns groups and options,
   * a `list` owns list items. A heading there is not a permitted child, and an
   * assistive technology then announces a coherent sounding but wrong
   * structure for the whole control.
   *
   * So the header renders as the permitted child that names the section, and
   * each row keeps its section-local position and set size. Native assistive
   * technology still receives the header role, which has no such composition
   * constraint.
   */
  virtualizedCollectionRole?: 'list' | 'listbox' | 'grid' | 'treegrid' | 'radiogroup' | 'group';
  /** @internal One-based row position for a virtualized grid section header. */
  accessibilityRowIndex?: number;
  /** @internal Total row count for a virtualized grid section header. */
  accessibilityRowCount?: number;
  testID?: string;
  style?: HappierStyleProp;
}>;

/**
 * A layered row's content (`contentBesidePressable`) lets presses through to the press target beneath it. The web
 * inherits `none` down the tree, so a control opts back in with `auto`; native skips a `none` subtree entirely, so
 * there the content is `box-none` and its leaves that are not controls are `none` (the Collection's cells).
 */
export const HAPPIER_ROW_CONTENT_POINTER_EVENTS = Platform.OS === 'web' ? 'none' : 'box-none';
/** A layered row's control: its own press target over the row's. */
export const HAPPIER_ROW_CONTROL_POINTER_EVENTS = 'auto';
const ROW_LAYER_STYLE: ViewStyle = { width: '100%', minWidth: 0 };
const ROW_LAYER_TARGET_STYLE: HappierPortableStyle = { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, minHeight: 0 };

export type HappierListItemProps = Readonly<{
  rowRole?: HappierCollectionRowRole;
  /**
   * The row's own content. Alone it owns the whole row structurally; beside a
   * semantic title/subtitle it is the row body, rendered after them in the
   * label column. It is never dropped, so no caller loses content silently.
   *
   * Interactive trailing content belongs in `accessory` with
   * `accessoryOutsidePressable`, because the body sits inside the row's own
   * primary Pressable.
   */
  children?: ReactNode;
  /** A bounded semantic row title. Omit it to let children own the row structurally. */
  title?: string;
  subtitle?: string;
  detail?: string;
  /** Decorated text inside the incumbent text hosts, without replacing row anatomy or names. */
  titleContent?: ReactNode;
  subtitleContent?: ReactNode;
  detailContent?: ReactNode;
  /**
   * Optional line bounds for the three semantic text slots.
   *
   * They exist because a virtualized collection with no fixed row height
   * approaches an unmounted row by `averageItemLength * index`
   * (`components/List.tsx#onScrollToIndexFailed`). A row whose title is free to
   * grow to any height makes that average describe no row in particular, so a
   * reveal lands somewhere else and the reader's scroll estimate drifts as they
   * page. Bounding the growth is the collection's own decision, not the row's,
   * which is why it is a prop here rather than a style each caller re-derives.
   *
   * Omitted, the slot keeps growing exactly as before: this is a capability a
   * caller opts into, never a default that starts truncating existing rows.
   */
  titleNumberOfLines?: number;
  subtitleNumberOfLines?: number;
  detailNumberOfLines?: number;
  /**
   * `middle` keeps the title on one line and gives up its middle, never its end: a path keeps its file
   * name, a name keeps its disambiguating suffix. Omitted, the title wraps or ends in a tail ellipsis.
   */
  titleEllipsizeMode?: 'middle';
  /** Decorative leading content; the row's label remains its text. */
  icon?: ReactNode;
  /** Trailing content such as the shared item overflow adapter. */
  accessory?: ReactNode;
  /**
   * Let the accessory take its own line rather than starve the row's text.
   *
   * The default row keeps every part on one line: the label column shrinks to
   * nothing so the accessory always fits. That is right for a small trailing
   * affordance and wrong for a row whose accessory is a set of real controls —
   * at a narrow width, the reader's largest type size, or a long localization,
   * the controls keep their intrinsic width and the title is squeezed out.
   *
   * With this on, the row wraps and the text column keeps at least half of it.
   * Neither number nor breakpoint decides that: an accessory that does not fit
   * beside a text column with an equal claim on the row moves below it, and the
   * text column then takes the whole width. The platform mirrors the physical
   * placement under RTL and never touches render, focus or announcement order.
   */
  accessoryWraps?: boolean;
  /** The accessory always takes its own line under the row's content: a card's action beneath its body. */
  accessoryBelow?: boolean;
  /** A page select may keep its content width beside the label in a narrow desktop column. Phones stack it. */
  fieldAccessory?: boolean;
  /** With `fieldAccessory`: width of sibling controls sharing the accessory slot (a glyph and its gap), kept out of the field's room. */
  fieldAccessorySiblingPx?: number;
  /** Keep an interactive accessory outside the row's primary Pressable. */
  accessoryOutsidePressable?: boolean;
  /**
   * The row's content carries its own controls (a port chip with its menu) in the middle of the row, where
   * `accessory` cannot reach. The press target then fills the row beneath its content instead of wrapping it, so
   * no control nests inside it: presses on the content fall through to the row (the content passes pointer
   * events through), and the parts that are controls opt back in with {@link HAPPIER_ROW_CONTROL_POINTER_EVENTS}.
   * The row keeps its one name, focus ring, hover, selection and keyboard behaviour; each control is its own
   * press and focus target after it.
   */
  contentBesidePressable?: boolean;
  /** @internal The accessory's menu is open: hover-revealed row actions stay shown while it is. */
  accessoryHeld?: boolean;
  /** @internal The accessory is only the row's actions trigger (no other control beside it). */
  accessoryIsRowActions?: boolean;
  tone?: HappierTone;
  /**
   * Colour for the trailing detail when it is the row's one loud fact (an
   * attention reason, a presence problem). Omitted, the detail stays quiet.
   */
  detailTone?: HappierTone;
  /**
   * The caller owns the action; this component owns only its press presentation.
   * The activation event travels with it so a collection owner can read the
   * modifier keys one press was made with.
   */
  onPress?: (event?: HappierGestureResponderEvent) => unknown;
  /** @internal Composite-owner secondary action request. */
  onContextMenu?: (event: unknown) => void;
  disabled?: boolean;
  busy?: boolean;
  selected?: boolean;
  accessibilityRole?: 'radio' | 'option' | 'button';
  accessibilityExpanded?: boolean;
  accessibilityPositionInSet?: number;
  accessibilitySetSize?: number;
  /** Injected by an app adapter when no PluginUiProvider theme is in scope. */
  theme?: HappierUiTheme;
  /** Core's in-app multiplier; absent, the mounted environment retains text-scale ownership. */
  textScale?: number;
  /** Resolved by the shared page-row metrics owner from the adapter's density and pointer facts. */
  pageRowMetrics?: HappierPageRowMetrics;
  /**
   * The host's row height in place of the density's (a declarative mount's row floor; `0` lets content size
   * the row). A row is its own hit area: neither this nor a finger ever grows the row past its design.
   */
  minimumTouchTarget?: number;
  density?: HappierItemDensity;
  showDivider?: boolean;
  /** Lets the shared behavior disable secondary actions with the row. */
  hasSecondaryActions?: boolean;
  /** Overrides the row's accessible name without adding a second visible label. */
  accessibilityLabel?: string;
  /**
   * Describes what the row does or is, beside — never instead of — its name.
   *
   * Reached through the same accessibility identity the shared pressable owner
   * already holds, so a described row keeps one accessible name and one
   * description rather than folding the description into the name.
   *
   * React Native carries this as `accessibilityHint`. React Native Web has no
   * mapping for that prop, so the web row additionally renders the description
   * as a referenced-only node and points `aria-describedby` at it.
   */
  accessibilityHint?: string;
  testID?: string;
  style?: HappierStyleProp;
  /** @internal Assigned by HappierItemGroup's radio projection. */
  itemGroupRadioIndex?: number;
  /** @internal Supplied by a virtualized collection owner that sees unmounted rows. */
  rovingCollectionItem?: HappierRovingCollectionItem;
  /** @internal The virtualized listbox/grid projection owns the row role. */
  suppressListItemRole?: boolean;
  /** @internal One-based grid row position, projected from the collection traversal. */
  accessibilityRowIndex?: number;
  /** @internal Grid's total row count, projected from the same traversal. */
  accessibilityRowCount?: number;
}>;

const NAVIGATION_ROW_FOCUS_RING_WIDTH = 1;
/** The least air above and below a navigation row's text when it wraps past the row's height. */
const NAVIGATION_ROW_TEXT_FLOOR_PX = 4;

// The trailing meta column (`HAPPIER_META_COLUMN_STYLE`); its tabular figures come through `tabularNumbers`.
const DETAIL_TEXT_STYLE: HappierPortableStyle = {
  textAlign: HAPPIER_META_COLUMN_STYLE.textAlign,
  minWidth: HAPPIER_META_COLUMN_STYLE.minWidth,
  flexShrink: 1,
  maxWidth: '40%',
};

const listStyle: ViewStyle = {
  width: '100%',
  minWidth: 0,
};

const sectionStyle: ViewStyle = {
  width: '100%',
  minWidth: 0,
};

const sectionHeadingStyle: ViewStyle = { flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 };
// The band's name and count keep their width; what the rows share is what gives way on a narrow band.
const sectionHeadingTitleStyle: HappierPortableStyle = { flexShrink: 0 };
// What the group's rows share follows its count (lab `rp` L: "Left behind 3 · their sessions ended…"); its one action ends the band.
const sectionHeadingDescriptionStyle: HappierPortableStyle = { flexShrink: 1 };
const sectionHeadingActionStyle: HappierPortableStyle = { marginLeft: 'auto' };
const sectionHeadingTrailingStyle: HappierPortableStyle = { marginLeft: 'auto', textAlign: 'right' };

const itemStyle: ViewStyle = {
  width: '100%',
  minWidth: 0,
};

function textStyle(
  theme: HappierUiTheme,
  typography: HappierUiTypography | null,
  role: HappierTypeRole,
  color: string,
): HappierPortableStyle {
  return { ...resolveHappierTypeRoleStyle(role, theme, typography), color };
}

/** A real React Native/RNW list container, never a custom marker host. */
export function HappierList({
  children,
  accessibilityLabel,
  testID,
  style,
}: HappierListProps) {
  return (
    <View
      accessibilityRole="list"
      role="list"
      aria-label={accessibilityLabel}
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      style={[listStyle, style]}
    >
      {children}
    </View>
  );
}

/** Whether a hover-revealing row's actions are drawn now; `null` outside such a row (always drawn). */
const HappierRowActionsRevealContext = createContext<boolean | null>(null);

/** Wraps a row's overflow control so a precise pointer reveals it with the row; it stays laid out and named. */
export function HappierRowActionsReveal(props: Readonly<{ children: ReactNode }>): ReactElement {
  const revealed = useContext(HappierRowActionsRevealContext);
  if (revealed === null) return <>{props.children}</>;
  return <HappierRowActionRevealSlot revealed={revealed}>{props.children}</HappierRowActionRevealSlot>;
}

/** A card corner's actions fade (a positioned overlay). */
const CARD_ACTIONS_REVEAL_TRANSITION = {
  transitionProperty: 'opacity',
  transitionDuration: `${HAPPIER_MOTION_V1.fastMs}ms`,
  transitionTimingFunction: HAPPIER_MOTION_V1.standardEasingCss,
} as ViewStyle;

const COLLECTION_ROW_FILL_TRANSITION = {
  transitionProperty: 'background-color',
  transitionDuration: `${HAPPIER_MOTION_V1.fastMs}ms`,
  transitionTimingFunction: HAPPIER_MOTION_V1.standardEasingCss,
} as ViewStyle;

function collectionPalette(theme: HappierUiTheme, palette: ReturnType<typeof useOptionalHappierUiPalette>) {
  return palette ?? resolveHappierUiPalette(theme);
}

/** A labelled subset within a {@link HappierList}. */
export function HappierListSection({
  children,
  title,
  titleContent,
  count,
  description,
  titleRole = 'label',
  action,
  virtualizedCollectionRole,
  accessibilityRowIndex,
  accessibilityRowCount,
  testID,
  style,
}: HappierListSectionProps) {
  const theme = useOptionalHappierUiTheme();
  const hostTypography = useOptionalHappierUiTypography();
  const titleStyle = theme
    ? titleRole === 'micro'
      // A dense collection's group band: the shared group-label step (lab `.grp`), one step under the rows.
      ? { ...resolveHappierTextStepStyle(HAPPIER_COLLECTION_LIST_TEXT.groupTitle, hostTypography), color: theme.colors.secondaryText }
      : titleRole === 'group'
        // A resting list's group heading on the page canvas (lab phone `.grp`): the group heading step, in text.
        ? { ...resolveHappierTextStepStyle(HAPPIER_COLLECTION_LIST_TEXT.groupHeading, hostTypography), color: theme.colors.text }
        : titleRole === 'section'
          ? { ...resolveHappierPageTextStyle('sectionTitle', hostTypography), color: theme.colors.text }
          : textStyle(theme, hostTypography, 'label', theme.colors.text)
    : undefined;
  const quietStyle = theme
    ? titleRole === 'section'
      ? { ...resolveHappierPageTextStyle('sectionTitle', hostTypography), fontWeight: '400' as const, color: theme.colors.mutedText }
      : titleRole === 'micro' || titleRole === 'group'
        ? { ...resolveHappierTextStepStyle(HAPPIER_COLLECTION_LIST_TEXT.groupCount, hostTypography), color: theme.colors.mutedText }
        : textStyle(theme, hostTypography, titleRole, theme.colors.mutedText)
    : undefined;
  // The visible heading: the title, its count and what its rows share. Only the title is the group's name.
  const hasAction = action !== undefined && action !== null && action !== false;
  // A dense band's end holds its one trailing fact: its action when it has one ("Left behind 3 · …" then "Clean
  // up"), otherwise what its rows share ("Needs you 5 … You act next", lab `.grp`).
  const trailingDescription = (titleRole === 'micro' || titleRole === 'group') && !hasAction;
  const heading = count === undefined && description === undefined && !hasAction
    ? <HappierText accessible={false} style={titleStyle}>{titleContent ?? title}</HappierText>
    : (
      <View style={sectionHeadingStyle}>
        <HappierText accessible={false} numberOfLines={1} style={[titleStyle, sectionHeadingTitleStyle]}>{titleContent ?? title}</HappierText>
        {count === undefined ? null : (
          <HappierText accessible={false} tabularNumbers style={quietStyle}>{String(count)}</HappierText>
        )}
        {description === undefined ? null : (
          <HappierText accessible={false} numberOfLines={1} style={[quietStyle, sectionHeadingDescriptionStyle, trailingDescription ? sectionHeadingTrailingStyle : null]}>
            {count === undefined || trailingDescription ? description : `· ${description}`}
          </HappierText>
        )}
        {hasAction ? <View style={sectionHeadingActionStyle}>{action}</View> : null}
      </View>
    );
  if (virtualizedCollectionRole !== undefined) {
    // `role` is the web projection and wins over `accessibilityRole` in React
    // Native Web, so native assistive technology still hears a section header.
    if (virtualizedCollectionRole === 'grid' || virtualizedCollectionRole === 'treegrid') {
      return (
        <>
          <View
            role="row"
            aria-label={title}
            aria-rowindex={accessibilityRowIndex}
            // @ts-expect-error React Native's published types omit collection-item facts.
            accessibilityCollectionItem={accessibilityRowIndex === undefined || accessibilityRowCount === undefined
              ? undefined
              : {
                  rowIndex: accessibilityRowIndex - 1,
                  columnIndex: 0,
                  rowSpan: 1,
                  columnSpan: 1,
                  heading: true,
                }}
            accessibilityRole="header"
            accessibilityLabel={title}
            testID={testID}
            style={[sectionStyle, style]}
          >
            <View role="columnheader">
              {/** The permitted grid cell owns the visible heading. */}
              {heading}
            </View>
          </View>
          {children}
        </>
      );
    }
    return (
      <View
        role={virtualizedCollectionRole === 'list' ? 'listitem' : 'group'}
        aria-label={title}
        accessibilityRole="header"
        accessibilityLabel={title}
        testID={testID}
        style={[sectionStyle, style]}
      >
        {/** The permitted child owns the accessible name; its visible heading stays out of that name. */}
        {heading}
        {children}
      </View>
    );
  }
  return (
    <View
      role="group"
      aria-label={title}
      accessibilityLabel={title}
      testID={testID}
      style={[sectionStyle, style]}
    >
      {/** The group owns the accessible name; its visible heading stays out of that name. */}
      {heading}
      {children}
    </View>
  );
}

/**
 * A field in a narrow row takes the space its row leaves beside the label, on a phone as on a pane;
 * it stacks beneath only when that space is below the field's narrowest trigger. The label keeps the
 * smaller of the shared column and what it really needs: the measured natural width of a short name,
 * plus its title accessory (a marker) and that accessory's gap. A short-named row is not held to 200px.
 *
 * Every row adapter (core `Item`, the public plugin `Item`) supplies the same measured facts; the label
 * column is decided only here.
 */
export function resolveHappierPageRowFieldMaxWidth(input: Readonly<{
  rowWidthPx: number | null;
  rowInsetPx?: number;
  /** The name's measured natural width; null while unmeasured or when the title is not plain text. */
  titleNaturalWidthPx?: number | null;
  /** A title accessory beside the name: its measured width, null while unmeasured. Omit when there is none. */
  titleAccessoryWidthPx?: number | null;
  /** The gap between the name and its title accessory. */
  titleAccessoryGapPx?: number;
  /** Width of sibling controls sharing the accessory slot with the field (a role's runs-as glyph and its gap). */
  siblingPx?: number;
  /**
   * The widest room beside the label in which the field's value filled its box (it was being cut).
   * Room that is no wider moves the field beneath its label, where the value reads in full.
   */
  fieldSaturatedAtPx?: number | null;
}>): number | null {
  const width = input.rowWidthPx;
  if (!isHappierPageRowNarrow(width) || width === null) return null;
  const naturalLabelPx = input.titleNaturalWidthPx == null || input.titleAccessoryWidthPx === null
    ? null
    : input.titleNaturalWidthPx + (input.titleAccessoryWidthPx === undefined
      ? 0
      : (input.titleAccessoryGapPx ?? 0) + input.titleAccessoryWidthPx);
  const labelColumnPx = naturalLabelPx === null
    ? HAPPIER_PAGE_METRICS.sectionTextMinWidthPx
    : Math.min(HAPPIER_PAGE_METRICS.sectionTextMinWidthPx, naturalLabelPx);
  const available = width - 2 * (input.rowInsetPx ?? HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx)
    - HAPPIER_PAGE_METRICS.rowLeadingGapPx - labelColumnPx - (input.siblingPx ?? 0);
  if (available < HAPPIER_FIELD_BOX_METRICS.triggerMinWidthPx) return null;
  if (input.fieldSaturatedAtPx != null && available <= input.fieldSaturatedAtPx + 0.5) return null;
  return available;
}

/**
 * A semantic list row shared by executable Plugin UI and declarative adapters.
 * Custom children retain the structural list-item contract; title/subtitle rows
 * acquire the one shared press/pending and accessibility mechanism instead of
 * reimplementing it in each consumer. A row given both renders both: the
 * semantic label first, then the children as its body.
 */
export function HappierListItem({
  rowRole,
  children,
  title,
  subtitle,
  detail,
  titleContent,
  subtitleContent,
  detailContent,
  titleNumberOfLines,
  subtitleNumberOfLines,
  detailNumberOfLines,
  titleEllipsizeMode,
  icon,
  accessory,
  accessoryWraps,
  accessoryBelow,
  fieldAccessory,
  fieldAccessorySiblingPx,
  accessoryOutsidePressable,
  contentBesidePressable,
  accessoryHeld,
  accessoryIsRowActions,
  tone = 'neutral',
  detailTone,
  onPress,
  onContextMenu,
  disabled,
  busy,
  selected,
  accessibilityRole,
  accessibilityExpanded,
  accessibilityPositionInSet,
  accessibilitySetSize,
  theme,
  textScale,
  pageRowMetrics,
  minimumTouchTarget,
  density,
  showDivider,
  hasSecondaryActions,
  accessibilityLabel,
  accessibilityHint,
  testID,
  style,
  itemGroupRadioIndex,
  rovingCollectionItem,
  suppressListItemRole,
  accessibilityRowIndex,
  accessibilityRowCount,
}: HappierListItemProps) {
  // A middle ellipsis on the web is two runs (the web draws only a tail one); native uses the platform's mode.
  const titleMiddleRequested = titleEllipsizeMode === 'middle' && typeof title === 'string' && titleContent === undefined;
  const titleMiddle = titleMiddleRequested && Platform.OS === 'web' ? splitForWebMiddleEllipsis(title) : null;
  const titleMiddleNative = titleMiddleRequested && titleMiddle === null;
  const paintColor = useHappierMaterialColorResolver();
  const environmentTheme = useOptionalHappierUiTheme();
  const hostTypography = useOptionalHappierUiTypography();
  // React Native Web 0.21 drops `accessibilityHint` entirely and emits a
  // description only from `aria-describedby`, so a web row needs a referenced
  // node of its own. Native keeps the hint prop and needs no extra node.
  const generatedRowDescriptionId = useId().replace(/[^a-zA-Z0-9_-]/gu, '');
  const rowDescriptionId = accessibilityHint && Platform.OS === 'web'
    ? `happier-list-item-description-${generatedRowDescriptionId}`
    : undefined;
  const resolvedTheme = theme ?? environmentTheme;
  // Inside a page section's sheet a row takes the page row anatomy: the page
  // row insets and height, the page title/description steps, and a full-width
  // hairline to the next row.
  const pageSection = useHappierPageSection();
  // Inside a navigation column (a `HappierCollectionList`) a row takes the navigation anatomy: flat
  // on the plane, inset by the shared gutter, the plane's selected chip and a heavier open title.
  const navigationRow = useHappierCollectionListRow() && pageSection === null;
  // A list row in a widget body stands on the body's edge: the frame's inset is the only one.
  const bodyEdgeRow = useContext(HappierBodyEdgeContext) && rowRole !== 'menu';
  const navigationPalette = useOptionalHappierUiPalette(theme ?? environmentTheme);
  // Inside a Collection's table or list a row takes the dense collection anatomy (full bleed, hairline,
  // whole-row hover and open fills, the open row's leading edge); see `HappierCollectionTableRowContext`.
  const collectionItem = useHappierCollectionTableRow();
  const treeRow = useContext(HappierCollectionTreeRowContext);
  const collectionRow = collectionItem !== null && pageSection === null && !navigationRow;
  // The open row (its detail is showing) carries the edge; a row in the bulk set is filled without one.
  const openRow = useContext(HappierListRowOpenContext);
  const cardRing = useContext(HappierCardSelectionRingContext);
  const cardCorner = useContext(HappierCardActionsCornerContext);
  const [collectionRowHovered, setCollectionRowHovered] = useState(false);
  const [cardActionsShown, setCardActionsShown] = useState({ hovered: false, focused: false });
  const reducedMotion = useOptionalHappierUiAccessibility()?.reducedMotion === true;
  // Page and Collection rows with wrapping controls share the existing narrow
  // row measurement: controls move below rather than squeezing the label.
  const measuresPageRow = (pageSection !== null || collectionItem !== null) && accessoryWraps === true
    && accessory !== undefined && accessory !== null;
  const [pageRowWidthPx, setPageRowWidthPx] = useState<number | null>(null);
  const pageRowInsetPx = pageSection?.rowInsetPx;
  const [detailWidthPx, setDetailWidthPx] = useState<number | null>(null);
  const [titleNaturalWidthPx, setTitleNaturalWidthPx] = useState<number | null>(null);
  const [leadingWidthPx, setLeadingWidthPx] = useState<number | null>(null);
  // The hairline under a page row starts at its text: past the measured leading glyph column and its gap.
  const pageRowDividerInset = pageSection === null ? null : happierPageRowDividerInset({
    rowInsetPx: pageSection.rowInsetPx,
    leadingPx: icon ? (leadingWidthPx ?? HAPPIER_PAGE_METRICS.rowLeadingColumnPx) + HAPPIER_PAGE_METRICS.rowLeadingGapPx : 0,
  });
  const measuresDetail = pageSection !== null && Boolean(detail) && isHappierPageRowNarrow(pageRowWidthPx);
  // A field beside a short name needs only that name's room (see `resolveHappierPageRowFieldMaxWidth`).
  const measuresFieldLabel = pageSection !== null && fieldAccessory === true && isHappierPageRowNarrow(pageRowWidthPx);
  const measuresTitle = (measuresDetail || measuresFieldLabel) && Boolean(title);
  // The room at which the field's value last filled its box (see `resolveHappierPageRowFieldMaxWidth`).
  const [fieldSaturatedAtPx, setFieldSaturatedAtPx] = useState<number | null>(null);
  const handleFieldSaturated = useCallback((maxWidthPx: number) => {
    setFieldSaturatedAtPx((current) => (current !== null && current >= maxWidthPx ? current : maxWidthPx));
  }, []);
  const fieldMaxWidthPx = useMemo(() => (pageRowInsetPx !== undefined && fieldAccessory === true
    ? resolveHappierPageRowFieldMaxWidth({
      rowWidthPx: pageRowWidthPx,
      rowInsetPx: pageRowInsetPx,
      titleNaturalWidthPx: measuresFieldLabel ? titleNaturalWidthPx : null,
      ...(fieldAccessorySiblingPx === undefined ? {} : { siblingPx: fieldAccessorySiblingPx }),
      fieldSaturatedAtPx,
    })
    : null), [fieldAccessory, fieldAccessorySiblingPx, fieldSaturatedAtPx, measuresFieldLabel, pageRowInsetPx, pageRowWidthPx, titleNaturalWidthPx]);
  // A page row's trailing value summary reads at the row title's size in the regular face, as core page rows draw it.
  const pageDetailTextStyle = { ...resolveHappierTextStepStyle({ ...HAPPIER_PAGE_TEXT.rowTitle, weight: 'regular' }, hostTypography), ...pageRowMetrics?.title };
  const handleDetailLayout = useCallback((event: Readonly<{ nativeEvent: Readonly<{ layout: Readonly<{ width: number }> }> }>) => {
    const width = event.nativeEvent.layout.width;
    if (Number.isFinite(width) && width > 0) setDetailWidthPx(current => current === width ? current : width);
  }, []);
  const handleTitleLayout = useCallback((event: Readonly<{ nativeEvent: Readonly<{ layout: Readonly<{ width: number }> }> }>) => {
    const width = event.nativeEvent.layout.width;
    if (Number.isFinite(width) && width > 0) setTitleNaturalWidthPx(current => current === width ? current : width);
  }, []);
  const handleLeadingLayout = useCallback((event: Readonly<{ nativeEvent: Readonly<{ layout: Readonly<{ width: number }> }> }>) => {
    const width = event.nativeEvent.layout.width;
    if (Number.isFinite(width) && width > 0) setLeadingWidthPx(current => current === width ? current : width);
  }, []);
  const handlePageRowLayout = useCallback((event: Readonly<{ nativeEvent: Readonly<{ layout: Readonly<{ width: number }> }> }>) => {
    const next = event.nativeEvent.layout.width;
    if (!Number.isFinite(next) || next <= 0) return;
    setPageRowWidthPx((current) => (current === next ? current : next));
  }, []);
  // A page row's control follows the one row-accessory rule core's `Item` uses: a wrapping control is
  // adaptive, any other control is an operation that stays beside its label while the label keeps its column.
  const [pageAccessoryWidthPx, setPageAccessoryWidthPx] = useState<number | null>(null);
  const handlePageAccessoryLayout = useCallback((event: Readonly<{ nativeEvent: Readonly<{ layout: Readonly<{ width: number }> }> }>) => {
    const next = event.nativeEvent.layout.width;
    if (!Number.isFinite(next) || next <= 0) return;
    setPageAccessoryWidthPx((current) => (current === next ? current : next));
  }, []);
  const hasAccessory = accessory !== undefined && accessory !== null;
  const { beneath: detailBeneath, inlineMaxWidthPx: detailInlineMaxWidthPx } = resolveHappierPageRowDetailLayout({
    rowWidthPx: measuresDetail ? pageRowWidthPx : null,
    detailWidthPx,
    titleNaturalWidthPx,
    rowInsetPx: pageRowInsetPx ?? HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx,
    leadingColumnWidthPx: icon ? leadingWidthPx ?? HAPPIER_PAGE_METRICS.rowLeadingColumnPx : 0,
    trailingWidthPx: resolvedTheme ? resolvedTheme.spacing.small + (hasAccessory ? pageAccessoryWidthPx ?? 0 : 0) : 0,
    detailGapPx: resolvedTheme?.spacing.small ?? 0,
  });
  const stackPageAccessory = (accessoryBelow === true && hasAccessory)
    || (pageSection !== null && hasAccessory && fieldMaxWidthPx === null && isHappierPageRowAccessoryStacked({
      kind: accessoryWraps === true ? 'adaptive' : 'operation',
      rowWidthPx: pageRowWidthPx,
      accessoryWidthPx: pageAccessoryWidthPx,
    }))
    || (pageSection === null && measuresPageRow && fieldMaxWidthPx === null && isHappierPageRowNarrow(pageRowWidthPx));
  // Only the inline position reports the control's natural width; a stacked control spans the row.
  const onPageAccessoryLayout = pageSection !== null && !stackPageAccessory ? handlePageAccessoryLayout : undefined;
  // Outside the pressable the control's own container carries the row's trailing inset.
  const onOutsidePageAccessoryLayout = onPageAccessoryLayout && pageSection !== null
    ? (event: Readonly<{ nativeEvent: Readonly<{ layout: Readonly<{ width: number }> }> }>) => onPageAccessoryLayout({
      nativeEvent: { layout: { width: event.nativeEvent.layout.width - pageSection.rowInsetPx } },
    })
    : undefined;
  const fieldLayout = useMemo(() => ({
    maxWidthPx: fieldMaxWidthPx,
    stacked: stackPageAccessory,
    onFieldSaturated: handleFieldSaturated,
  }), [fieldMaxWidthPx, handleFieldSaturated, stackPageAccessory]);
  const pageAccessory = pageSection !== null
    ? <HappierPageRowFieldLayoutContext.Provider value={fieldLayout}>{accessory}</HappierPageRowFieldLayoutContext.Provider>
    : accessory;
  const hasSemanticContent = title !== undefined
    || subtitle !== undefined
    || detail !== undefined
    || icon !== undefined;

  if (hasSemanticContent && !resolvedTheme) {
    throw new Error(
      'HappierListItem semantic rows require a PluginUiProvider theme or an explicit theme from the host adapter.',
    );
  }

  // React Native permits text only beneath a Text host. Plugin authoring needs
  // to keep the ergonomic `renderItem={(item) => item.label}` form, so this
  // boundary turns only primitive text into the canonical text owner. Elements
  // remain untouched: their own semantic component owns their text treatment.
  const customContent = typeof children === 'string' || typeof children === 'number'
    ? <HappierText>{children}</HappierText>
    : children;
  const groupItem = useHappierItemGroupItemBehavior({
    role: accessibilityRole,
    itemGroupRadioIndex,
    disabled,
    busy,
  });
  // One row-side roving consumer. A virtualized collection owner wins because
  // it is the only participant that can see the rows the virtualizer has not
  // mounted; an ItemGroup radio projection serves the static case.
  const roving: HappierRovingCollectionItem | null = rovingCollectionItem
    ?? (groupItem.grouped
      ? {
          isTabStop: groupItem.tabStopIndex === itemGroupRadioIndex,
          onKeyDown: groupItem.onKeyDown,
          register: groupItem.targetRef,
        }
      : null);
  const behavior = resolveHappierItemBehavior({
    role: accessibilityRole,
    selected,
    disabled,
    busy,
    expanded: accessibilityExpanded,
    isTabStop: roving?.isTabStop,
    density,
    hasPrimaryAction: onPress !== undefined,
    hasSecondaryActions,
    hasAccessory: accessory !== undefined && accessory !== null,
    accessoryOutsidePressable,
    showDivider,
  });
  const isInteractive = behavior.interactive;
  const requestedRowHeight = minimumTouchTarget ?? ({
    comfortable: 44,
    cozy: 42,
    compact: 38,
    tight: 36,
  } satisfies Record<HappierItemDensity, number>)[behavior.density];
  // A row draws at its design height under every pointer. A full-width row is its own hit area and rows
  // stack flush, so a finger's target never grows the row or reaches into its neighbours (DESIGN.md →
  // touch targets are hit areas, not drawn sizes).
  const rowHeight = navigationRow ? HAPPIER_COLLECTION_LIST_METRICS.rowMinHeight
    : pageSection && pageRowMetrics ? pageRowMetrics.minHeightPx : requestedRowHeight;

  const renderSemanticContent = (isBusy: boolean, includeAccessory: boolean) => {
    if (!resolvedTheme) return customContent;
    const busyIndicator = isBusy ? (
      <HappierSpinner
        aria-hidden
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        size="small"
        color={resolvedTheme.colors.secondaryText}
      />
    ) : null;
    if (!hasSemanticContent) return (
      <View style={{ flexDirection: 'row', alignItems: 'center', minWidth: 0 }}>
        {/* This slot stays mounted when pending changes; custom row state belongs to its author. */}
        <View style={{ flex: 1, minWidth: 0 }}>{customContent}</View>
        {busyIndicator}
      </View>
    );

    const titleColor = resolvedTheme.colors[HAPPIER_TONE_COLOR_TOKEN[tone]];
    const pageCompact = behavior.density === 'compact' || behavior.density === 'tight';
    return (
      <View
        style={navigationRow ? {
          flexDirection: 'row',
          alignItems: 'center',
          columnGap: HAPPIER_COLLECTION_LIST_METRICS.rowGlyphGap,
          // The row's design height; a wrapped title grows it, never the glyph.
          minHeight: rowHeight - 2 * NAVIGATION_ROW_FOCUS_RING_WIDTH,
          paddingLeft: resolveHappierCollectionListRowPadding(0).paddingLeft - NAVIGATION_ROW_FOCUS_RING_WIDTH,
          paddingRight: resolveHappierCollectionListRowPadding(0).paddingRight - NAVIGATION_ROW_FOCUS_RING_WIDTH,
          paddingVertical: NAVIGATION_ROW_TEXT_FLOOR_PX,
        } : pageSection ? {
          // A stacked control moves beneath the row's text. With a leading glyph the glyph and the text stay
          // together on the first line and the control wraps to its own, so the glyph is never alone above them.
          flexDirection: stackPageAccessory && includeAccessory && !icon ? 'column' : 'row',
          alignItems: stackPageAccessory && includeAccessory ? (icon ? 'flex-start' : 'stretch') : 'center',
          flexWrap: stackPageAccessory && includeAccessory && icon ? 'wrap' : 'nowrap',
          columnGap: HAPPIER_PAGE_METRICS.rowLeadingGapPx,
          rowGap: 10,
          minHeight: Math.max(
            rowHeight,
            pageRowMetrics?.minHeightPx ?? (pageCompact ? HAPPIER_PAGE_METRICS.compactRowMinHeightPx : HAPPIER_PAGE_METRICS.rowMinHeightPx),
          ),
          paddingHorizontal: pageSection.rowInsetPx,
          paddingVertical: pageRowMetrics?.paddingVerticalPx ?? (pageCompact
            ? HAPPIER_PAGE_METRICS.compactRowPaddingVerticalPx
            : HAPPIER_PAGE_METRICS.rowPaddingVerticalPx),
        } : {
          flexDirection: 'row',
          alignItems: 'center',
          flexWrap: accessoryWraps ? 'wrap' : 'nowrap',
          gap: resolvedTheme.spacing.small,
          minHeight: rowHeight,
          paddingHorizontal: bodyEdgeRow ? 0 : resolvedTheme.spacing.medium,
          paddingVertical: resolvedTheme.spacing.small,
        }}
      >
        {icon ? (
          <View
            onLayout={pageSection !== null && detail ? handleLeadingLayout : undefined}
            accessible={false}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={navigationRow
              ? { width: HAPPIER_COLLECTION_LIST_METRICS.rowGlyphBox, alignItems: 'center', justifyContent: 'center' }
              : pageSection
              ? { minWidth: HAPPIER_PAGE_METRICS.rowLeadingColumnPx, alignItems: 'center', justifyContent: 'center' }
              : { alignItems: 'center', justifyContent: 'center' }}
          >
            {icon}
          </View>
        ) : null}
        <View
          style={pageSection ? {
            // A page row decides placement by measurement, not by wrapping.
            ...(stackPageAccessory && includeAccessory && !icon ? { flexGrow: 0, flexShrink: 0 } : { flex: 1 }),
            minWidth: 0,
            gap: 0,
          } : {
            flex: 1,
            // Half the row when the accessory may wrap, because that is what
            // makes it wrap at all: a column free to shrink to nothing lets an
            // accessory keep its intrinsic width and take the title's space
            // instead of its own line.
            minWidth: accessoryWraps ? '50%' : 0,
            gap: resolvedTheme.spacing.xsmall,
          }}
        >
          {title ? (
            <HappierText
              numberOfLines={titleMiddle === null ? titleMiddleNative ? 1 : titleNumberOfLines : undefined}
              {...(titleMiddleNative ? { ellipsizeMode: 'middle' as const } : {})}
              textScale={textScale}
              style={navigationRow
                ? {
                    ...resolveHappierTextStepStyle(
                      HAPPIER_COLLECTION_LIST_TEXT[selected === true ? 'rowTitleSelected' : 'rowTitle'],
                      hostTypography,
                    ),
                    color: titleColor,
                  }
                : pageSection
                ? { ...resolveHappierPageTextStyle('rowTitle', hostTypography), ...pageRowMetrics?.title, color: titleColor }
                : textStyle(resolvedTheme, hostTypography, 'label', titleColor)}
              {...(titleMiddle === null ? {} : { baseStyle: HAPPIER_MIDDLE_ELLIPSIS_STYLE.row })}
            >
              {titleMiddle === null ? titleContent ?? title : (
                <>
                  <HappierText style={HAPPIER_MIDDLE_ELLIPSIS_STYLE.head} numberOfLines={1}>{titleMiddle.head}</HappierText>
                  <HappierText style={HAPPIER_MIDDLE_ELLIPSIS_STYLE.tail} numberOfLines={1}>{titleMiddle.tail}</HappierText>
                </>
              )}
            </HappierText>
          ) : null}
          {detailBeneath && detail ? <HappierText
            textScale={textScale}
            style={{ ...resolveHappierPageTextStyle('rowDescription', hostTypography), ...pageRowMetrics?.subtitle,
              color: detailTone === undefined ? resolvedTheme.colors.secondaryText : resolvedTheme.colors[HAPPIER_TONE_COLOR_TOKEN[detailTone]] }}
          >{detailContent ?? detail}</HappierText> : null}
          {subtitle ? (
            <HappierText
              numberOfLines={subtitleNumberOfLines}
              textScale={textScale}
              style={pageSection
                ? { ...resolveHappierPageTextStyle('rowDescription', hostTypography), ...(pageRowMetrics?.subtitle ?? { marginTop: 2 }), color: resolvedTheme.colors.secondaryText }
                : textStyle(resolvedTheme, hostTypography, 'meta', resolvedTheme.colors.secondaryText)}
            >
              {subtitleContent ?? subtitle}
            </HappierText>
          ) : null}
          {customContent}
        </View>
        {detail && !detailBeneath ? (
          <HappierText
            numberOfLines={detailNumberOfLines}
            textScale={textScale}
            tabularNumbers
            style={[
              // On a page a trailing value summary reads at the row title's size in the regular face, as
              // core page rows draw it; elsewhere it is the collection's quiet meta.
              pageSection
                ? { ...pageDetailTextStyle,
                    color: detailTone === undefined ? resolvedTheme.colors.secondaryText : resolvedTheme.colors[HAPPIER_TONE_COLOR_TOKEN[detailTone]] }
                : textStyle(
                resolvedTheme,
                hostTypography,
                'micro',
                detailTone === undefined
                  ? resolvedTheme.colors.secondaryText
                  : resolvedTheme.colors[HAPPIER_TONE_COLOR_TOKEN[detailTone]],
              ),
              // The trailing column is quiet metadata: it may never take the
              // title's width, and changing counts or ages must not jitter.
              DETAIL_TEXT_STYLE,
              detailInlineMaxWidthPx === null ? null : { maxWidth: detailInlineMaxWidthPx },
            ]}
          >
            {detailContent ?? detail}
          </HappierText>
        ) : null}
        {includeAccessory
          ? (pageSection && accessory !== undefined && accessory !== null
            ? <View
              onLayout={onPageAccessoryLayout}
              style={stackPageAccessory
                ? {
                  alignSelf: 'stretch',
                  alignItems: 'stretch',
                  // Beneath the text, on its edge: past the glyph column and the gap after it.
                  ...(icon ? { flexBasis: '100%', paddingLeft: HAPPIER_PAGE_METRICS.rowLeadingColumnPx + HAPPIER_PAGE_METRICS.rowLeadingGapPx } : {}),
                }
                : null}
            >{pageAccessory}</View>
            : accessory)
          : null}
        {busyIndicator}
        {measuresDetail || measuresTitle ? <>
          {measuresDetail ? <View aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" onLayout={handleDetailLayout}
            style={{ position: 'absolute', left: 0, top: 0, opacity: 0, pointerEvents: 'none' }}>
            {/* Measured in the inline detail's own type, so the beneath decision sees the width it would draw. */}
            <HappierText numberOfLines={1} textScale={textScale} style={pageDetailTextStyle}>{detailContent ?? detail}</HappierText>
          </View> : null}
          {measuresTitle ? <View aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" onLayout={handleTitleLayout}
            style={{ position: 'absolute', left: 0, top: 0, opacity: 0, pointerEvents: 'none' }}>
            <HappierText numberOfLines={1} textScale={textScale} style={{ ...resolveHappierPageTextStyle('rowTitle', hostTypography), ...pageRowMetrics?.title }}>{titleContent ?? title}</HappierText>
          </View> : null}
        </> : null}
      </View>
    );
  };

  const includeAccessory = behavior.accessoryPlacement === 'inside';
  const isGridRow = suppressListItemRole === true && accessibilityRole === 'button';
  // A grid card's actions sit at its title line's end; a precise pointer reveals them, touch always shows them.
  const cardCornerAccessory = isGridRow && cardCorner !== null && behavior.accessoryPlacement === 'outside' && accessory
    ? cardCorner : null;
  const cardActionsVisible = cardCornerAccessory === null || !hasHappierPrecisePointer()
    || cardActionsShown.hovered || cardActionsShown.focused || accessoryHeld === true;
  // A touch row, and every row of a resting list (a phone, a narrow page), keeps its actions out of the
  // row's flow: rows run to the page's margin and the age keeps the trailing edge (lab phone list). A `•••`
  // on every row of a long list is noise, so touch reaches them by long press (the platform's context
  // menu) and a precise pointer sees them over the row's end while the row is the pointer's. The trigger
  // stays mounted and announced, so the menu anchors to the row's end, focus reveals it and assistive
  // technology reaches it; it shows while its menu is open.
  const precisePointer = hasHappierPrecisePointer();
  const overlayRowActions = collectionRow && hasSecondaryActions && accessoryIsRowActions === true && cardCornerAccessory === null
    && behavior.accessoryPlacement === 'outside'
    && (!precisePointer || collectionItem?.hairline === false);
  // A mouse or trackpad shows a collection row's actions when the row is the pointer's, has focus inside, is
  // selected or is open: a `•••` on every row is noise (the lab's rows carry only the chevron). The cell stays
  // laid out and announced, so the age keeps its place and assistive technology and Tab still reach it. The
  // overflow itself reads this through `HappierRowActionsReveal`, whatever else shares the row's accessory.
  const hoverRevealRowActions = collectionRow && hasSecondaryActions && cardCornerAccessory === null
    && behavior.accessoryPlacement === 'outside' && !overlayRowActions && precisePointer;
  const rowActionsRevealed = collectionRowHovered || cardActionsShown.focused || selected === true || openRow || accessoryHeld === true;
  const layered = contentBesidePressable === true && isInteractive && resolvedTheme !== undefined && resolvedTheme !== null;
  const withRowLayer = (style: HappierPortableStyle): HappierPortableStyle => layered ? { ...style, ...ROW_LAYER_TARGET_STYLE } : style;
  const pressTarget = isInteractive && resolvedTheme ? (
    <HappierPressable
      testID={testID}
      accessibilityRole={accessibilityRole ?? 'button'}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      describedById={rowDescriptionId}
      checked={accessibilityRole === 'radio' ? selected === true : undefined}
      selected={accessibilityRole === 'option' ? selected : undefined}
      current={navigationRow && selected === true ? 'page' : undefined}
      expanded={accessibilityExpanded}
      accessibilityPositionInSet={accessibilityPositionInSet}
      accessibilitySetSize={accessibilitySetSize}
      disabled={disabled}
      busy={busy}
      controlRef={roving?.register}
      tabIndex={behavior.tabIndex}
      onKeyDown={roving?.onKeyDown}
      onFocusChange={focused => {
        if (focused) roving?.onFocus?.();
        if (hoverRevealRowActions) setCardActionsShown(state => state.focused === focused ? state : { ...state, focused });
      }}
      onContextMenu={onContextMenu}
      onLongPress={Platform.OS === 'web' ? undefined : onContextMenu}
      onPress={(event) => onPress?.(event)}
      // Rows stack flush: the row's own box is its hit area, never reaching over the next row.
      hitReach={0}
      style={(state) => withRowLayer(navigationRow ? ({
        minWidth: 0,
        minHeight: rowHeight,
        marginHorizontal: HAPPIER_COLLECTION_LIST_METRICS.rowInset,
        borderRadius: HAPPIER_COLLECTION_LIST_METRICS.rowRadius,
        // The transparent border is the inset ring's band; the content padding subtracts its
        // width, so the glyph still lands on the shared text edge.
        borderWidth: NAVIGATION_ROW_FOCUS_RING_WIDTH,
        borderColor: 'transparent',
        // Inset, like every list row: rows stack flush in a scrolling column that clips outside them.
        ...happierFocusRingStyle({ visible: state.focused, color: resolvedTheme.colors.focus, placement: 'inset' }),
        backgroundColor: selected === true
          ? paintColor(navigationPalette?.navigationSelected ?? resolvedTheme.colors.elevatedSurface)
          : state.hovered && !state.disabled ? paintColor(navigationPalette?.navigationHover ?? 'transparent') : 'transparent',
        opacity: state.disabled && !state.busy
          ? 0.5
          : state.pressed ? HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle : 1,
        ...happierPressTransitionStyle(state.pressed, ['opacity']),
      }) : collectionRow ? ({
        width: '100%',
        minWidth: 0,
        minHeight: rowHeight,
        // The ring is keyboard focus only; the row's fills are the wrapper's, across the accessory too.
        // Inset: the row spans its group, which clips anything drawn outside it.
        borderWidth: 1,
        borderColor: 'transparent',
        ...happierFocusRingStyle({ visible: state.focused, color: resolvedTheme.colors.focus, placement: 'inset' }),
        opacity: state.disabled && !state.busy
          ? 0.5
          : state.pressed ? HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle : 1,
        ...happierPressTransitionStyle(state.pressed, ['opacity']),
      }) : ({
        width: '100%',
        minWidth: 0,
        minHeight: rowHeight,
        borderWidth: 1,
        borderColor: 'transparent',
        // Inset: the row spans its list, which clips anything drawn outside it.
        ...happierFocusRingStyle({ visible: state.focused, color: resolvedTheme.colors.focus, placement: 'inset' }),
        borderRadius: resolvedTheme.radii.control,
        // Selection paints a soft control fill (never an accent bar); focus
        // paints only the ring above. They are separate axes, so a focused row
        // is never mistaken for the open one and the open one stays visible on
        // touch.
        backgroundColor: selected === true && !cardRing ? paintColor(resolvedTheme.colors.control) : 'transparent',
        // Rows are high-frequency and text-led: the gentle dip, never a scale.
        opacity: state.disabled && !state.busy
          ? 0.5
          : state.pressed ? HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle : 1,
        ...happierPressTransitionStyle(state.pressed, ['opacity']),
      }))}
    >
      {(state) => layered ? null : renderSemanticContent(state.busy, includeAccessory)}
    </HappierPressable>
  ) : renderSemanticContent(busy === true, includeAccessory);
  // The press target fills the row under its content; the content lies over it and lets presses through.
  const row = layered ? (
    <View style={ROW_LAYER_STYLE}>
      {pressTarget}
      <View pointerEvents={HAPPIER_ROW_CONTENT_POINTER_EVENTS} style={{ minHeight: rowHeight, borderWidth: 1, borderColor: 'transparent' }}>
        {renderSemanticContent(busy === true, includeAccessory)}
      </View>
    </View>
  ) : pressTarget;

  // Out of the row's flow, so the age keeps the row's trailing edge (lab A1p); it overlays that edge while shown.
  const overlaidRowActions = overlayRowActions && accessory ? (
    <View
      // @ts-expect-error React Native's role union omits RNW's standard gridcell role (a grid row's cell).
      role={isGridRow ? 'gridcell' : undefined}
      pointerEvents="box-none"
      // On the row's trailing inset, where an accessory cell would hold the trigger; a resting list's rows end on
      // the page's edge, and so does the trigger.
      style={{ position: 'absolute', end: collectionItem?.hairline === false ? 0 : resolvedTheme?.spacing.medium ?? 0, top: 0, bottom: 0, justifyContent: 'center' }}>
      <HappierRowActionRevealSlot revealed={accessoryHeld === true || (precisePointer && collectionRowHovered)}>
        {accessory}
      </HappierRowActionRevealSlot>
    </View>
  ) : null;
  const rowAccessory = overlaidRowActions ?? accessory;
  const rowContent = isGridRow && cardCornerAccessory !== null ? (
    <>
      {/* @ts-expect-error React Native's role union omits RNW's standard gridcell role. */}
      <View role="gridcell" style={{ flex: 1, minWidth: 0, alignSelf: 'stretch' }}>{row}</View>
      {/* @ts-expect-error React Native's role union omits RNW's standard gridcell role. */}
      <View role="gridcell" style={[{
        position: 'absolute', top: cardCornerAccessory.top, end: cardCornerAccessory.end, height: cardCornerAccessory.height,
        justifyContent: 'center', opacity: cardActionsVisible ? 1 : 0,
      }, reducedMotion ? null : CARD_ACTIONS_REVEAL_TRANSITION]}>{accessory}</View>
    </>
  ) : isGridRow ? (
    behavior.accessoryPlacement === 'outside' ? (
      <>
        {/* @ts-expect-error React Native's role union omits RNW's standard gridcell role. */}
        <View role="gridcell" style={stackPageAccessory ? { width: '100%', minWidth: 0 } : { flex: 1, minWidth: accessoryWraps ? '50%' : 0 }}>{row}</View>
        {/* The control keeps the row's trailing inset, as its text keeps the leading one (and a selected row's fill shows it). */}
        {/* @ts-expect-error React Native's role union omits RNW's standard gridcell role. */}
        {overlaidRowActions ?? (accessory ? <View role="gridcell" style={stackPageAccessory ? null : { paddingEnd: resolvedTheme?.spacing.medium ?? 0 }}>{accessory}</View> : null)}
      </>
    ) : (
      // @ts-expect-error React Native's role union omits RNW's standard gridcell role.
      <View role="gridcell" style={{ flex: 1, minWidth: 0 }}>{row}</View>
    )
  ) : behavior.accessoryPlacement === 'outside' && pageSection ? (
    // A page row keeps its control on the row's inset: beside the label with
    // the trailing inset, or — on a narrow row with a wide control — beneath
    // the label on the label's edge.
    <View style={{
      flexDirection: stackPageAccessory ? 'column' : 'row',
      alignItems: stackPageAccessory ? 'stretch' : 'center',
      minWidth: 0,
    }}>
      <View style={stackPageAccessory ? null : { flex: 1, minWidth: 0 }}>{row}</View>
      <View
        style={stackPageAccessory
          ? {
              alignSelf: 'stretch',
              // Like core's stacked page controls: a field spans the row; a bounded control keeps its own width.
              alignItems: 'stretch',
              paddingLeft: pageSection.rowInsetPx,
              paddingRight: pageSection.rowInsetPx,
              paddingBottom: HAPPIER_PAGE_METRICS.rowPaddingVerticalPx,
              marginTop: -4,
            }
          : { paddingRight: pageSection.rowInsetPx }}
        onLayout={onOutsidePageAccessoryLayout}
      >
        {pageAccessory}
      </View>
    </View>
  ) : behavior.accessoryPlacement === 'outside' || collectionRow ? (
    // Keep the collection's press target at the same depth when responsive
    // composition adds or removes its trailing controls, preserving focus.
    <View style={includeAccessory ? undefined : {
      flexDirection: stackPageAccessory ? 'column' : 'row',
      alignItems: stackPageAccessory ? 'stretch' : 'center',
      flexWrap: accessoryWraps ? 'wrap' : 'nowrap',
      minWidth: 0,
      // The control keeps the row's trailing inset, as its text keeps the leading one.
      ...(accessory && !overlayRowActions && !stackPageAccessory ? { paddingEnd: resolvedTheme?.spacing.medium ?? 0 } : {}),
    }}>
      <View style={includeAccessory || stackPageAccessory ? null : { flex: 1, minWidth: accessoryWraps ? '50%' : 0 }}>{row}</View>
      {includeAccessory ? null : rowAccessory}
    </View>
  ) : row;

  return (
    <HappierRowActionsRevealContext.Provider value={hoverRevealRowActions ? rowActionsRevealed : null}>
    <View
      {...(suppressListItemRole ? (isGridRow ? {
        role: 'row',
        'aria-selected': selected === true ? true : false,
        accessibilityState: { selected: selected === true },
        'aria-rowindex': accessibilityRowIndex,
        // Native Android reads the same row membership from this collection
        // item fact; RN's public View types omit the platform prop.
        accessibilityCollectionItem: accessibilityRowIndex === undefined || accessibilityRowCount === undefined
          ? undefined
          : {
              rowIndex: accessibilityRowIndex - 1,
              columnIndex: 0,
              rowSpan: 1,
              columnSpan: 1,
              heading: false,
            },
      } : {}) : { role: 'listitem' })}
      {...(suppressListItemRole && isGridRow && treeRow !== null ? {
        'aria-level': treeRow.level,
        ...(treeRow.expanded === undefined ? {} : { 'aria-expanded': treeRow.expanded }),
      } : {})}
      aria-posinset={suppressListItemRole && isGridRow && treeRow !== null ? treeRow.posInSet
        : isInteractive ? undefined : accessibilityPositionInSet}
      aria-setsize={suppressListItemRole && isGridRow && treeRow !== null ? treeRow.setSize
        : isInteractive ? undefined : accessibilitySetSize}
      {...(!isInteractive && accessibilityLabel ? { 'aria-label': accessibilityLabel, accessibilityLabel } : {})}
      {...(!isInteractive && accessibilityHint ? { accessibilityHint } : {})}
      {...(!isInteractive && rowDescriptionId ? { 'aria-describedby': rowDescriptionId } : {})}
      {...(!isInteractive && (disabled === true || busy === true)
        ? {
            'aria-disabled': true,
            accessibilityState: behavior.accessibilityState,
          }
        : {})}
      testID={isInteractive ? undefined : testID}
      // RNW observes only at mount, so retain the measurement when a compound accessory arrives later.
      onLayout={pageSection !== null || collectionItem !== null ? handlePageRowLayout : undefined}
      {...(collectionRow && isInteractive ? {
        onMouseEnter: () => { setCollectionRowHovered(true); },
        onMouseLeave: () => { setCollectionRowHovered(false); },
      } : {})}
      {...(cardCornerAccessory !== null && hasHappierPrecisePointer() ? {
        onMouseEnter: () => { setCardActionsShown(state => state.hovered ? state : { ...state, hovered: true }); },
        onMouseLeave: () => { setCardActionsShown(state => state.hovered ? { ...state, hovered: false } : state); },
        onFocus: () => { setCardActionsShown(state => state.focused ? state : { ...state, focused: true }); },
        onBlur: () => { setCardActionsShown(state => state.focused ? { ...state, focused: false } : state); },
      } : {})}
      style={[itemStyle, isGridRow ? {
        flexDirection: stackPageAccessory ? 'column' : 'row',
        alignItems: stackPageAccessory ? 'stretch' : 'center',
        flexWrap: accessoryWraps ? 'wrap' : 'nowrap',
        minWidth: 0,
      } : undefined, collectionRow && resolvedTheme ? {
        // The pointer's fill eases in at the fast step (web); selection lands at once.
        ...(reducedMotion ? {} : COLLECTION_ROW_FILL_TRANSITION),
        backgroundColor: selected === true || openRow
          ? paintColor(collectionPalette(resolvedTheme, navigationPalette).navigationSelected)
          : collectionRowHovered && isInteractive && disabled !== true
            ? paintColor(collectionPalette(resolvedTheme, navigationPalette).navigationHover)
            : 'transparent',
      } : undefined, style]}
    >
      {rowContent}
      {collectionRow && resolvedTheme ? (
        <>
          {/* Overlays, never layout: the row keeps the exact height its Collection planned. */}
          {collectionItem?.hairline === false ? null : (
            <View
              pointerEvents="none"
              style={{
                position: 'absolute', left: 0, right: 0, bottom: 0,
                height: happierPageRowDividerWidth(),
                backgroundColor: collectionPalette(resolvedTheme, navigationPalette).rowDivider,
              }}
            />
          )}
        </>
      ) : null}
      {rowDescriptionId ? (
        // Referenced only. `display: none` keeps it out of the row's visible
        // layout and out of its name computation, while the accessible-name
        // spec still reads a directly referenced hidden node for a description.
        <HappierText nativeID={rowDescriptionId} style={{ display: 'none' }}>
          {accessibilityHint}
        </HappierText>
      ) : null}
      {behavior.dividerVisible && pageSection ? (
        // A grid row lays its cells out in a row, so its hairline is an overlay on the row's foot rather than
        // a third flex cell (which collapsed to no width and left Collection page sheets undivided).
        <HappierDivider color={pageSection.rowDividerColor} style={isGridRow
          ? { height: happierPageRowDividerWidth(), position: 'absolute', left: 0, right: 0, bottom: 0, ...pageRowDividerInset }
          : { height: happierPageRowDividerWidth(), ...pageRowDividerInset }} />
      ) : behavior.dividerVisible && resolvedTheme ? (
        <HappierDivider color={resolvedTheme.colors.border} />
      ) : null}
    </View>
    </HappierRowActionsRevealContext.Provider>
  );
}
