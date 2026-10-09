import { useCallback, useContext, useId, useState, type ReactNode } from 'react';
import { Platform, View, type TextStyle, type ViewStyle } from 'react-native';

import {
  resolveHappierUiPalette,
  useOptionalHappierUiAccessibility,
  useOptionalHappierUiPalette,
  useOptionalHappierUiTheme,
  useOptionalHappierUiTypography,
} from '../../environment/context.js';
import {
  HAPPIER_DEFAULT_MINIMUM_INTERACTIVE_TARGET_SIZE,
  useHappierNativeMinimumInteractiveTargetSize,
} from '../../environment/interactiveTarget.js';
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
import { HAPPIER_PAGE_METRICS, isHappierPageRowNarrow } from '../layout/pageMetrics.js';
import { happierPageRowDividerWidth, useHappierPageSection } from '../layout/PageSection.js';
import { resolveHappierPageTextStyle } from '../layout/pageText.js';
import { HAPPIER_TONE_COLOR_TOKEN, type HappierTone } from '../semantics.js';
import { HappierText } from '../text/Text.js';
import { HAPPIER_META_COLUMN_STYLE } from '../text/metaColumn.js';
import { resolveHappierTypeRoleStyle } from '../text/typeRole.js';
import {
  resolveHappierItemBehavior,
  type HappierItemDensity,
  type HappierRovingCollectionItem,
} from './semantics.js';
import { useHappierItemGroupItemBehavior } from './ItemGroup.js';
import {
  HAPPIER_COLLECTION_LIST_METRICS,
  HAPPIER_COLLECTION_LIST_TEXT,
  HAPPIER_COLLECTION_SELECTED_EDGE_WIDTH,
  HappierListRowOpenContext,
  resolveHappierCollectionListRowPadding,
  useHappierCollectionListRow,
  useHappierCollectionTableRow,
} from './CollectionList.js';
import { resolveHappierTextStepStyle } from '../layout/pageText.js';

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
   * The type role of the heading's words; a dense table's groups take `caption`, and a group drawn as a page
   * section (a page-scrolling list's groups) takes the page's section title.
   */
  titleRole?: 'label' | 'caption' | 'section';
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
  virtualizedCollectionRole?: 'list' | 'listbox' | 'grid' | 'radiogroup' | 'group';
  /** @internal One-based row position for a virtualized grid section header. */
  accessibilityRowIndex?: number;
  /** @internal Total row count for a virtualized grid section header. */
  accessibilityRowCount?: number;
  testID?: string;
  style?: HappierStyleProp;
}>;

export type HappierListItemProps = Readonly<{
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
  /** Keep an interactive accessory outside the row's primary Pressable. */
  accessoryOutsidePressable?: boolean;
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
  /** Additive host floor; the mounted environment's native target always wins. */
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
const sectionHeadingTitleStyle: HappierPortableStyle = { flexShrink: 1 };
const sectionHeadingDescriptionStyle: HappierPortableStyle = { marginLeft: 'auto', flexShrink: 1, textAlign: 'right' };
const sectionHeadingActionStyle: HappierPortableStyle = { marginLeft: 'auto' };

const itemStyle: ViewStyle = {
  width: '100%',
  minWidth: 0,
};

function textStyle(
  theme: HappierUiTheme,
  typography: HappierUiTypography | null,
  role: Exclude<HappierTypeRole, 'heading'>,
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
    ? titleRole === 'caption'
      // A dense collection's group band: the shared group-label step (lab `.grp`), one step under the rows.
      ? { ...resolveHappierTextStepStyle(HAPPIER_COLLECTION_LIST_TEXT.groupTitle, hostTypography), color: theme.colors.secondaryText }
      : titleRole === 'section'
        ? { ...resolveHappierPageTextStyle('sectionTitle', hostTypography), color: theme.colors.text }
        : textStyle(theme, hostTypography, 'label', theme.colors.text)
    : undefined;
  const quietStyle = theme
    ? titleRole === 'section'
      ? { ...resolveHappierPageTextStyle('sectionTitle', hostTypography), fontWeight: '400' as const, color: theme.colors.mutedText }
      : titleRole === 'caption'
        ? { ...resolveHappierTextStepStyle(HAPPIER_COLLECTION_LIST_TEXT.groupCount, hostTypography), color: theme.colors.mutedText }
        : textStyle(theme, hostTypography, titleRole, theme.colors.mutedText)
    : undefined;
  // The visible heading: the title, its count and what its rows share. Only the title is the group's name.
  const hasAction = action !== undefined && action !== null && action !== false;
  const heading = count === undefined && description === undefined && !hasAction
    ? <HappierText accessible={false} style={titleStyle}>{titleContent ?? title}</HappierText>
    : (
      <View style={sectionHeadingStyle}>
        <HappierText accessible={false} numberOfLines={1} style={[titleStyle, sectionHeadingTitleStyle]}>{titleContent ?? title}</HappierText>
        {count === undefined ? null : (
          <HappierText accessible={false} tabularNumbers style={quietStyle}>{String(count)}</HappierText>
        )}
        {description === undefined ? null : (
          <HappierText accessible={false} numberOfLines={1} style={[quietStyle, sectionHeadingDescriptionStyle]}>{description}</HappierText>
        )}
        {hasAction ? <View style={description === undefined ? sectionHeadingActionStyle : null}>{action}</View> : null}
      </View>
    );
  if (virtualizedCollectionRole !== undefined) {
    // `role` is the web projection and wins over `accessibilityRole` in React
    // Native Web, so native assistive technology still hears a section header.
    if (virtualizedCollectionRole === 'grid') {
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
 * A semantic list row shared by executable Plugin UI and declarative adapters.
 * Custom children retain the structural list-item contract; title/subtitle rows
 * acquire the one shared press/pending and accessibility mechanism instead of
 * reimplementing it in each consumer. A row given both renders both: the
 * semantic label first, then the children as its body.
 */
export function HappierListItem({
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
  icon,
  accessory,
  accessoryWraps,
  accessoryOutsidePressable,
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
  const environmentTheme = useOptionalHappierUiTheme();
  const hostTypography = useOptionalHappierUiTypography();
  const nativeMinimumTouchTarget = useHappierNativeMinimumInteractiveTargetSize();
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
  const navigationPalette = useOptionalHappierUiPalette(theme ?? environmentTheme);
  // Inside a Collection's table or list a row takes the dense collection anatomy (full bleed, hairline,
  // whole-row hover and open fills, the open row's leading edge); see `HappierCollectionTableRowContext`.
  const collectionRow = useHappierCollectionTableRow() && pageSection === null && !navigationRow;
  // The open row (its detail is showing) carries the edge; a row in the bulk set is filled without one.
  const openRow = useContext(HappierListRowOpenContext);
  const [collectionRowHovered, setCollectionRowHovered] = useState(false);
  const reducedMotion = useOptionalHappierUiAccessibility()?.reducedMotion === true;
  // A page row whose control is wide (`accessoryWraps`) measures itself, like
  // Happier core's adaptive page rows: too narrow for a label column and a
  // control column side by side, the control moves beneath the label.
  const measuresPageRow = pageSection !== null && accessoryWraps === true
    && accessory !== undefined && accessory !== null;
  const [pageRowNarrow, setPageRowNarrow] = useState(false);
  const handlePageRowLayout = useCallback((event: Readonly<{ nativeEvent: Readonly<{ layout: Readonly<{ width: number }> }> }>) => {
    const next = isHappierPageRowNarrow(event.nativeEvent.layout.width);
    setPageRowNarrow((current) => (current === next ? current : next));
  }, []);
  const stackPageAccessory = measuresPageRow && pageRowNarrow;
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
  const requestedTargetSize = minimumTouchTarget ?? ({
    comfortable: HAPPIER_DEFAULT_MINIMUM_INTERACTIVE_TARGET_SIZE,
    cozy: 42,
    compact: 38,
    tight: 36,
  } satisfies Record<HappierItemDensity, number>)[behavior.density];
  // A navigation row keeps its compact height under a pointer; the platform's touch floor still wins.
  const baseTargetSize = navigationRow ? HAPPIER_COLLECTION_LIST_METRICS.rowMinHeight : requestedTargetSize;
  const targetSize = isInteractive
    ? Math.max(baseTargetSize, nativeMinimumTouchTarget ?? 0)
    : baseTargetSize;

  const renderSemanticContent = (isBusy: boolean, includeAccessory: boolean) => {
    if (!hasSemanticContent || !resolvedTheme) return customContent;

    const titleColor = resolvedTheme.colors[HAPPIER_TONE_COLOR_TOKEN[tone]];
    const pageCompact = behavior.density === 'compact' || behavior.density === 'tight';
    return (
      <View
        style={navigationRow ? {
          flexDirection: 'row',
          alignItems: 'center',
          columnGap: HAPPIER_COLLECTION_LIST_METRICS.rowGlyphGap,
          // The row's height is the target; a wrapped title grows it, never the glyph.
          minHeight: targetSize - 2 * NAVIGATION_ROW_FOCUS_RING_WIDTH,
          paddingLeft: resolveHappierCollectionListRowPadding(0).paddingLeft - NAVIGATION_ROW_FOCUS_RING_WIDTH,
          paddingRight: resolveHappierCollectionListRowPadding(0).paddingRight - NAVIGATION_ROW_FOCUS_RING_WIDTH,
          paddingVertical: NAVIGATION_ROW_TEXT_FLOOR_PX,
        } : pageSection ? {
          flexDirection: stackPageAccessory && includeAccessory ? 'column' : 'row',
          alignItems: stackPageAccessory && includeAccessory ? 'stretch' : 'center',
          flexWrap: 'nowrap',
          columnGap: HAPPIER_PAGE_METRICS.rowLeadingGapPx,
          rowGap: 10,
          minHeight: Math.max(
            targetSize,
            pageCompact ? HAPPIER_PAGE_METRICS.compactRowMinHeightPx : HAPPIER_PAGE_METRICS.rowMinHeightPx,
          ),
          paddingHorizontal: pageSection.rowInsetPx,
          paddingVertical: pageCompact
            ? HAPPIER_PAGE_METRICS.compactRowPaddingVerticalPx
            : HAPPIER_PAGE_METRICS.rowPaddingVerticalPx,
        } : {
          flexDirection: 'row',
          alignItems: 'center',
          flexWrap: accessoryWraps ? 'wrap' : 'nowrap',
          gap: resolvedTheme.spacing.small,
          minHeight: targetSize,
          paddingHorizontal: resolvedTheme.spacing.medium,
          paddingVertical: resolvedTheme.spacing.small,
        }}
      >
        {icon ? (
          <View
            accessible={false}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={navigationRow
              ? { width: HAPPIER_COLLECTION_LIST_METRICS.rowGlyphBox, alignItems: 'center', justifyContent: 'center' }
              : { alignItems: 'center', justifyContent: 'center' }}
          >
            {icon}
          </View>
        ) : null}
        <View
          style={pageSection ? {
            // A page row decides placement by measurement, not by wrapping.
            ...(stackPageAccessory && includeAccessory ? { flexGrow: 0, flexShrink: 0 } : { flex: 1 }),
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
              numberOfLines={titleNumberOfLines}
              style={navigationRow
                ? {
                    ...resolveHappierTextStepStyle(
                      HAPPIER_COLLECTION_LIST_TEXT[selected === true ? 'rowTitleSelected' : 'rowTitle'],
                      hostTypography,
                    ),
                    color: titleColor,
                  }
                : pageSection
                ? { ...resolveHappierPageTextStyle('rowTitle', hostTypography), color: titleColor }
                : textStyle(resolvedTheme, hostTypography, 'label', titleColor)}
            >
              {titleContent ?? title}
            </HappierText>
          ) : null}
          {subtitle ? (
            <HappierText
              numberOfLines={subtitleNumberOfLines}
              style={pageSection
                ? { ...resolveHappierPageTextStyle('rowDescription', hostTypography), color: resolvedTheme.colors.secondaryText, marginTop: 2 }
                : textStyle(resolvedTheme, hostTypography, 'body', resolvedTheme.colors.secondaryText)}
            >
              {subtitleContent ?? subtitle}
            </HappierText>
          ) : null}
          {customContent}
        </View>
        {detail ? (
          <HappierText
            numberOfLines={detailNumberOfLines}
            tabularNumbers
            style={[
              textStyle(
                resolvedTheme,
                hostTypography,
                'caption',
                detailTone === undefined
                  ? resolvedTheme.colors.secondaryText
                  : resolvedTheme.colors[HAPPIER_TONE_COLOR_TOKEN[detailTone]],
              ),
              // The trailing column is quiet metadata: it may never take the
              // title's width, and changing counts or ages must not jitter.
              DETAIL_TEXT_STYLE,
            ]}
          >
            {detailContent ?? detail}
          </HappierText>
        ) : null}
        {includeAccessory
          ? (pageSection && accessory !== undefined && accessory !== null
            ? <View style={stackPageAccessory ? { alignSelf: 'stretch', alignItems: 'stretch' } : null}>{accessory}</View>
            : accessory)
          : null}
        {isBusy ? (
          <HappierSpinner
            aria-hidden
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            size="small"
            color={resolvedTheme.colors.secondaryText}
          />
        ) : null}
      </View>
    );
  };

  const includeAccessory = behavior.accessoryPlacement === 'inside';
  const isGridRow = suppressListItemRole === true && accessibilityRole === 'button';
  const row = isInteractive && resolvedTheme ? (
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
      onFocusChange={focused => { if (focused) roving?.onFocus?.(); }}
      onContextMenu={onContextMenu}
      onLongPress={Platform.OS === 'web' ? undefined : onContextMenu}
      onPress={(event) => onPress?.(event)}
      style={(state) => navigationRow ? ({
        minWidth: 0,
        minHeight: targetSize,
        marginHorizontal: HAPPIER_COLLECTION_LIST_METRICS.rowInset,
        borderRadius: HAPPIER_COLLECTION_LIST_METRICS.rowRadius,
        // The transparent border is the inset ring's band; the content padding subtracts its
        // width, so the glyph still lands on the shared text edge.
        borderWidth: NAVIGATION_ROW_FOCUS_RING_WIDTH,
        borderColor: 'transparent',
        // Inset, like every list row: rows stack flush in a scrolling column that clips outside them.
        ...happierFocusRingStyle({ visible: state.focused, color: resolvedTheme.colors.focus, placement: 'inset' }),
        backgroundColor: selected === true
          ? navigationPalette?.navigationSelected ?? resolvedTheme.colors.elevatedSurface
          : state.hovered && !state.disabled ? navigationPalette?.navigationHover ?? 'transparent' : 'transparent',
        opacity: state.disabled && !state.busy
          ? 0.5
          : state.pressed ? HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle : 1,
        ...happierPressTransitionStyle(state.pressed, ['opacity']),
      }) : collectionRow ? ({
        width: '100%',
        minWidth: 0,
        minHeight: targetSize,
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
        minHeight: targetSize,
        borderWidth: 1,
        borderColor: 'transparent',
        // Inset: the row spans its list, which clips anything drawn outside it.
        ...happierFocusRingStyle({ visible: state.focused, color: resolvedTheme.colors.focus, placement: 'inset' }),
        borderRadius: resolvedTheme.radii.control,
        // Selection paints a soft control fill (never an accent bar); focus
        // paints only the ring above. They are separate axes, so a focused row
        // is never mistaken for the open one and the open one stays visible on
        // touch.
        backgroundColor: selected === true ? resolvedTheme.colors.control : 'transparent',
        // Rows are high-frequency and text-led: the gentle dip, never a scale.
        opacity: state.disabled && !state.busy
          ? 0.5
          : state.pressed ? HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle : 1,
        ...happierPressTransitionStyle(state.pressed, ['opacity']),
      })}
    >
      {(state) => renderSemanticContent(state.busy, includeAccessory)}
    </HappierPressable>
  ) : renderSemanticContent(busy === true, includeAccessory);

  const rowContent = isGridRow ? (
    behavior.accessoryPlacement === 'outside' ? (
      <>
        {/* @ts-expect-error React Native's role union omits RNW's standard gridcell role. */}
        <View role="gridcell" style={{ flex: 1, minWidth: accessoryWraps ? '50%' : 0 }}>{row}</View>
        {/* @ts-expect-error React Native's role union omits RNW's standard gridcell role. */}
        {accessory ? <View role="gridcell">{accessory}</View> : null}
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
      >
        {accessory}
      </View>
    </View>
  ) : behavior.accessoryPlacement === 'outside' ? (
    <View style={{
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: accessoryWraps ? 'wrap' : 'nowrap',
      minWidth: 0,
    }}>
      <View style={{ flex: 1, minWidth: accessoryWraps ? '50%' : 0 }}>{row}</View>
      {accessory}
    </View>
  ) : row;

  return (
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
      aria-posinset={isInteractive ? undefined : accessibilityPositionInSet}
      aria-setsize={isInteractive ? undefined : accessibilitySetSize}
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
      onLayout={measuresPageRow ? handlePageRowLayout : undefined}
      {...(collectionRow && isInteractive ? {
        onPointerEnter: () => { setCollectionRowHovered(true); },
        onPointerLeave: () => { setCollectionRowHovered(false); },
      } : {})}
      style={[itemStyle, isGridRow ? {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: accessoryWraps ? 'wrap' : 'nowrap',
        minWidth: 0,
      } : undefined, collectionRow && resolvedTheme ? {
        // The pointer's fill eases in at the fast step (web); selection lands at once.
        ...(reducedMotion ? {} : COLLECTION_ROW_FILL_TRANSITION),
        backgroundColor: selected === true || openRow
          ? collectionPalette(resolvedTheme, navigationPalette).navigationSelected
          : collectionRowHovered && isInteractive && disabled !== true
            ? collectionPalette(resolvedTheme, navigationPalette).navigationHover
            : 'transparent',
      } : undefined, style]}
    >
      {rowContent}
      {collectionRow && resolvedTheme ? (
        <>
          {/* Overlays, never layout: the row keeps the exact height its Collection planned. */}
          <View
            pointerEvents="none"
            style={{
              position: 'absolute', left: 0, right: 0, bottom: 0,
              height: happierPageRowDividerWidth(),
              backgroundColor: collectionPalette(resolvedTheme, navigationPalette).rowDivider,
            }}
          />
          {openRow ? (
            <View
              pointerEvents="none"
              style={{
                position: 'absolute', left: 0, top: 0, bottom: 0,
                width: HAPPIER_COLLECTION_SELECTED_EDGE_WIDTH,
                backgroundColor: resolvedTheme.colors.text,
              }}
            />
          ) : null}
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
        <HappierDivider color={pageSection.rowDividerColor} style={{ height: happierPageRowDividerWidth() }} />
      ) : behavior.dividerVisible && resolvedTheme ? (
        <HappierDivider color={resolvedTheme.colors.border} />
      ) : null}
    </View>
  );
}
