import type { ReactNode } from 'react';
import { View, type TextStyle, type ViewStyle } from 'react-native';

import { useOptionalHappierUiTheme } from '../../environment/context.js';
import {
  HAPPIER_DEFAULT_MINIMUM_INTERACTIVE_TARGET_SIZE,
  useHappierNativeMinimumInteractiveTargetSize,
} from '../../environment/interactiveTarget.js';
import type { HappierUiTheme } from '../../environment/types.js';
import type { HappierPortableStyle, HappierStyleProp } from '../portableTypes.js';
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
  children?: ReactNode;
  /** A bounded semantic row title. Omit it to render custom children structurally. */
  title?: string;
  subtitle?: string;
  detail?: string;
  /** Decorative leading content; the row's label remains its text. */
  icon?: ReactNode;
  /** Trailing content such as the shared item overflow adapter. */
  accessory?: ReactNode;
  /** Keep an interactive accessory outside the row's primary Pressable. */
  accessoryOutsidePressable?: boolean;
  tone?: HappierTone;
  /** The caller owns the action; this component owns only its press presentation. */
  onPress?: () => unknown;
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
 * reimplementing it in each consumer.
 */
export function HappierListItem({
  children,
  title,
  subtitle,
  detail,
  icon,
  accessory,
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
  testID,
  style,
  itemGroupRadioIndex,
  rovingCollectionItem,
  suppressListItemRole,
}: HappierListItemProps) {
  const environmentTheme = useOptionalHappierUiTheme();
  const nativeMinimumTouchTarget = useHappierNativeMinimumInteractiveTargetSize();
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
        <View style={{ flex: 1, minWidth: 0, gap: resolvedTheme.spacing.xsmall }}>
          {title ? <HappierText style={textStyle(resolvedTheme, 'label', titleColor)}>{title}</HappierText> : null}
          {subtitle ? <HappierText style={textStyle(resolvedTheme, 'body', resolvedTheme.colors.secondaryText)}>{subtitle}</HappierText> : null}
        </View>
        {detail ? <HappierText style={textStyle(resolvedTheme, 'caption', resolvedTheme.colors.secondaryText)}>{detail}</HappierText> : null}
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
      onPress={() => onPress?.()}
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
      {behavior.dividerVisible && resolvedTheme ? (
        <HappierDivider color={resolvedTheme.colors.border} />
      ) : null}
    </View>
  );
}
