import { useId, type ReactNode } from 'react';
import { Platform, View, type TextStyle, type ViewStyle } from 'react-native';

import { useOptionalHappierUiTheme } from '../../environment/context.js';
import {
  HAPPIER_DEFAULT_MINIMUM_INTERACTIVE_TARGET_SIZE,
  useHappierNativeMinimumInteractiveTargetSize,
} from '../../environment/interactiveTarget.js';
import type { HappierUiTheme } from '../../environment/types.js';
import type {
  HappierGestureResponderEvent,
  HappierPortableStyle,
  HappierStyleProp,
} from '../portableTypes.js';
import { HappierSpinner } from '../feedback/Spinner.js';
import { HappierPressable } from '../interaction/Pressable.js';
import { HappierDivider } from '../content/Foundation.js';
import { HAPPIER_TONE_COLOR_TOKEN, type HappierTone } from '../semantics.js';
import { HappierText } from '../text/Text.js';
import {
  resolveHappierItemBehavior,
  type HappierItemDensity,
  type HappierRovingCollectionItem,
} from './semantics.js';
import { useHappierItemGroupItemBehavior } from './ItemGroup.js';

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
  virtualizedCollectionRole?: 'list' | 'listbox';
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
   * The caller owns the action; this component owns only its press presentation.
   * The activation event travels with it so a collection owner can read the
   * modifier keys one press was made with.
   */
  onPress?: (event?: HappierGestureResponderEvent) => unknown;
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
  /** @internal The virtualized listbox projection owns the option row role. */
  suppressListItemRole?: boolean;
}>;

const listStyle: ViewStyle = {
  width: '100%',
  minWidth: 0,
};

const sectionStyle: ViewStyle = {
  width: '100%',
  minWidth: 0,
};

const itemStyle: ViewStyle = {
  width: '100%',
  minWidth: 0,
};

function textStyle(
  theme: HappierUiTheme,
  variant: keyof HappierUiTheme['typography'],
  color: string,
): HappierPortableStyle {
  const typography = theme.typography[variant];
  return {
    fontSize: typography.fontSize,
    lineHeight: typography.lineHeight,
    ...('fontWeight' in typography ? { fontWeight: typography.fontWeight as TextStyle['fontWeight'] } : {}),
    ...('fontFamily' in typography && typography.fontFamily
      ? { fontFamily: typography.fontFamily }
      : {}),
    color,
  };
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

/** A labelled subset within a {@link HappierList}. */
export function HappierListSection({
  children,
  title,
  virtualizedCollectionRole,
  testID,
  style,
}: HappierListSectionProps) {
  if (virtualizedCollectionRole !== undefined) {
    // `role` is the web projection and wins over `accessibilityRole` in React
    // Native Web, so native assistive technology still hears a section header.
    return (
      <View
        role={virtualizedCollectionRole === 'listbox' ? 'group' : 'listitem'}
        aria-label={title}
        accessibilityRole="header"
        accessibilityLabel={title}
        testID={testID}
        style={[sectionStyle, style]}
      >
        {/** The permitted child owns the accessible name; its visible heading stays out of that name. */}
        <HappierText accessible={false}>{title}</HappierText>
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
      <HappierText accessible={false}>{title}</HappierText>
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
  titleNumberOfLines,
  subtitleNumberOfLines,
  detailNumberOfLines,
  icon,
  accessory,
  accessoryWraps,
  accessoryOutsidePressable,
  tone = 'neutral',
  onPress,
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
}: HappierListItemProps) {
  const environmentTheme = useOptionalHappierUiTheme();
  const nativeMinimumTouchTarget = useHappierNativeMinimumInteractiveTargetSize();
  // React Native Web 0.21 drops `accessibilityHint` entirely and emits a
  // description only from `aria-describedby`, so a web row needs a referenced
  // node of its own. Native keeps the hint prop and needs no extra node.
  const generatedRowDescriptionId = useId().replace(/[^a-zA-Z0-9_-]/gu, '');
  const rowDescriptionId = accessibilityHint && Platform.OS === 'web'
    ? `happier-list-item-description-${generatedRowDescriptionId}`
    : undefined;
  const resolvedTheme = theme ?? environmentTheme;
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
  const targetSize = isInteractive
    ? Math.max(requestedTargetSize, nativeMinimumTouchTarget ?? 0)
    : requestedTargetSize;

  const renderSemanticContent = (isBusy: boolean, includeAccessory: boolean) => {
    if (!hasSemanticContent || !resolvedTheme) return customContent;

    const titleColor = resolvedTheme.colors[HAPPIER_TONE_COLOR_TOKEN[tone]];
    return (
      <View
        style={{
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
            style={{ alignItems: 'center', justifyContent: 'center' }}
          >
            {icon}
          </View>
        ) : null}
        <View
          style={{
            flex: 1,
            // Half the row when the accessory may wrap, because that is what
            // makes it wrap at all: a column free to shrink to nothing lets an
            // accessory keep its intrinsic width and take the title's space
            // instead of its own line.
            minWidth: accessoryWraps ? '50%' : 0,
            gap: resolvedTheme.spacing.xsmall,
          }}
        >
          {title ? <HappierText numberOfLines={titleNumberOfLines} style={textStyle(resolvedTheme, 'label', titleColor)}>{title}</HappierText> : null}
          {subtitle ? <HappierText numberOfLines={subtitleNumberOfLines} style={textStyle(resolvedTheme, 'body', resolvedTheme.colors.secondaryText)}>{subtitle}</HappierText> : null}
          {customContent}
        </View>
        {detail ? <HappierText numberOfLines={detailNumberOfLines} style={textStyle(resolvedTheme, 'caption', resolvedTheme.colors.secondaryText)}>{detail}</HappierText> : null}
        {includeAccessory ? accessory : null}
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
  const row = isInteractive && resolvedTheme ? (
    <HappierPressable
      testID={testID}
      accessibilityRole={accessibilityRole ?? 'button'}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      describedById={rowDescriptionId}
      checked={accessibilityRole === 'radio' ? selected === true : undefined}
      selected={accessibilityRole === 'option' ? selected : undefined}
      expanded={accessibilityExpanded}
      accessibilityPositionInSet={accessibilityPositionInSet}
      accessibilitySetSize={accessibilitySetSize}
      disabled={disabled}
      busy={busy}
      controlRef={roving?.register}
      tabIndex={behavior.tabIndex}
      onKeyDown={roving?.onKeyDown}
      onPress={(event) => onPress?.(event)}
      style={(state) => ({
        width: '100%',
        minWidth: 0,
        minHeight: targetSize,
        borderWidth: 1,
        borderColor: state.focused ? resolvedTheme.colors.focus : 'transparent',
        borderRadius: resolvedTheme.radii.control,
        opacity: state.disabled && !state.busy ? 0.5 : state.pressed ? 0.8 : 1,
      })}
    >
      {(state) => renderSemanticContent(state.busy, includeAccessory)}
    </HappierPressable>
  ) : renderSemanticContent(busy === true, includeAccessory);

  return (
    <View
      {...(suppressListItemRole ? {} : { role: 'listitem' })}
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
      style={[itemStyle, style]}
    >
      {behavior.accessoryPlacement === 'outside' ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', minWidth: 0 }}>
          <View style={{ flex: 1, minWidth: 0 }}>{row}</View>
          {accessory}
        </View>
      ) : row}
      {rowDescriptionId ? (
        // Referenced only. `display: none` keeps it out of the row's visible
        // layout and out of its name computation, while the accessible-name
        // spec still reads a directly referenced hidden node for a description.
        <HappierText nativeID={rowDescriptionId} style={{ display: 'none' }}>
          {accessibilityHint}
        </HappierText>
      ) : null}
      {behavior.dividerVisible && resolvedTheme ? (
        <HappierDivider color={resolvedTheme.colors.border} />
      ) : null}
    </View>
  );
}
