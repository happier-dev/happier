import { resolveThemeSurfaceState, useThemeSurfaceBinder } from '../presentation/themeSurfaceBinding.js';
import type { PluginUiActionBinding } from '@happier-dev/plugin-sdk/ui';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { createContext, useContext, type ReactElement, type ReactNode } from 'react';
import { View } from 'react-native';
import { HappierSurfaceGradientLayer } from '../presentation/layout/SurfaceGradientLayer.js';
import { HappierTextActionEdgeContext } from '../presentation/interaction/textActionEdge.js';

import { useOptionalHappierUiAccessibility, useOptionalHappierUiPalette } from '../environment/context.js';
import { HappierPressable, type HappierPressableStyleState } from '../presentation/interaction/Pressable.js';
import {
  happierDiscretePressStyle,
  happierPressTransitionStyle,
} from '../presentation/interaction/pressFeedback.js';
import type { HappierPortableStyle } from '../presentation/portableTypes.js';
import {
  resolveHappierButtonChrome,
  useHappierButtonMaterial,
} from '../presentation/interaction/buttonChrome.js';
import { HappierSpinner, iconMatchedSpinnerSize } from '../presentation/feedback/Spinner.js';
import { HappierText } from '../presentation/text/Text.js';
import { HAPPIER_ICON_BUTTON_SIZE, HAPPIER_ICON_BUTTON_WELL_SIZE, resolveHappierIconButtonChrome } from '../presentation/interaction/iconButtonChrome.js';
import { useHappierMaterialColorResolver } from '../presentation/layout/Surface.js';
import { PluginUiLeadingGlyphInkContext } from './Icon.js';

/** A phone state's action fills its column; set by the shared state owner, never a public Button prop. */
export const PluginUiButtonFillContext = createContext(false);
/**
 * A state's action in a container that never owns its page's primary (the host's `stateActions: 'quiet'`): a
 * primary Button there draws quiet. Set by the shared state owner around its action slots, never a public prop.
 */
export const PluginUiQuietStateActionContext = createContext(false);
/**
 * A sized state's action (a card, a pane): an author's Button there draws at the state action size the shared
 * state owner gives its own actions, so a plugin's empty state reads like the host's beside it. Set by the state
 * owner around its action slot, never a public prop.
 */
export const PluginUiStateActionSizeContext = createContext<ButtonSize | null>(null);
import {
  type PluginUiFocusTarget,
  usePluginUiFocusTargetBindingInternal,
} from './Focus.js';
import { usePluginTheme, usePluginTranslation } from './PluginUiProvider.js';
import { resolveAuthorText } from './resolveAuthorText.js';
import type { HappierPageOperation, HappierPageOperationTextResolver } from '../presentation/layout/pageOperations.js';

/**
 * Happier's button for plugin surfaces.
 *
 * A thin adapter: the press lifecycle, pending state, reentry guard and
 * accessibility identity all live in the shared presentation owner Happier core
 * renders too (UI-T27). This adapter supplies only what a plugin surface owns —
 * the chrome resolved from its projected theme, and the author's translated
 * label.
 *
 * `primary` fills with the host's accent; `secondary` uses the host's control
 * fill; `plain` drops the chrome for a dense row. All three are the same
 * geometry, because a plugin's actions should read as the host's actions.
 * `destructive` keeps the secondary surface and uses the theme's danger tone.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'plain' | 'destructive';
export type ButtonSize = 'normal' | 'small';

type ButtonCommonProps = Readonly<{
  /** Literal label. It provides the accessible name when no override is supplied. */
  title?: string;
  /** A key from this plugin's declared translation bundle; `title` is its fallback. */
  titleKey?: string;
  /** A translation key for an explicit accessible-name override. */
  accessibilityLabelKey?: string;
  variant?: ButtonVariant;
  /**
   * `small` for an action inside a dense layout (a row's peek, a card, a detail header): the host's
   * desktop control height on a pointer, never under the touch floor on a phone. Defaults to `normal`.
   */
  size?: ButtonSize;
  disabled?: boolean;
  /**
   * Declare the pending state for work this button did not start. An `onPress`
   * that returns a promise already drives it.
   */
  busy?: boolean;
  /** Leading glyph. Sized and tinted by the caller. */
  icon?: ReactNode;
  /** The side this button shares with a Menu's caret in a split button (Fix | ⌄). */
  joinedEdge?: 'start' | 'end';
  /** The label stays on one line and ends in "…" where the row has no room (a phone's action band). */
  singleLine?: boolean;
  /** Logical focus target transferred by the mounted host after author state changes. */
  focusTarget?: PluginUiFocusTarget;
  testID?: string;
  onPress: () => unknown;
  children?: ReactNode;
}>;

/** A visible title is enough to derive the public control's accessible name. */
type ButtonWithVisibleTitleProps = ButtonCommonProps & Readonly<{
  title: string;
  /** An override is optional only because `title` already names the control. */
  accessibilityLabel?: string;
}>;

/**
 * Icon-only and custom-content buttons are still focusable controls, so their
 * action name must be explicit at the public boundary.
 */
type ButtonWithExplicitAccessibleNameProps = ButtonCommonProps & Readonly<{
  accessibilityLabel: string;
}>;

export type ButtonProps = ButtonWithVisibleTitleProps | ButtonWithExplicitAccessibleNameProps;

function requireAccessibleButtonName(
  accessibilityLabel: string | undefined,
  visibleLabel: string | undefined,
): string {
  const name = accessibilityLabel ?? visibleLabel;
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('Button requires a non-empty accessible name through title or accessibilityLabel.');
  }
  return name;
}

export function Button({
  title,
  titleKey,
  accessibilityLabelKey,
  variant = 'primary',
  size = 'normal',
  disabled,
  busy,
  icon,
  joinedEdge,
  singleLine,
  accessibilityLabel,
  focusTarget,
  testID,
  onPress,
  children,
}: ButtonProps): ReactElement {
  const translate = usePluginTranslation();
  const label = resolveAuthorText(translate, title, titleKey);
  const resolvedAccessibilityLabel = resolveAuthorText(
    translate,
    accessibilityLabel,
    accessibilityLabelKey,
  );
  const accessibleName = requireAccessibleButtonName(resolvedAccessibilityLabel, label);
  const focusBinding = usePluginUiFocusTargetBindingInternal(focusTarget);
  const quietState = useContext(PluginUiQuietStateActionContext);
  const stateActionSize = useContext(PluginUiStateActionSizeContext);
  const face = useButtonFace(quietState && variant === 'primary' ? 'secondary' : variant, stateActionSize ?? size, disabled === true, joinedEdge);

  return (
    <HappierPressable
      themeSurface={{ surface: 'button', part: 'root' }}
      testID={testID}
      accessibilityLabel={accessibleName}
      disabled={disabled}
      busy={busy}
      onPress={onPress}
      controlRef={focusBinding}
      style={face.style}
    >
      {(state) => face.renderContent(state, {
        icon,
        ...(singleLine === true ? { singleLine: true } : {}),
        children: children ?? label,
        ...(testID ? { spinnerTestID: `${testID}-spinner` } : {}),
      })}
    </HappierPressable>
  );
}

// In a stretching column a labelled button keeps its own width on the leading edge (`isHappierInlineControl`).
Button.happierInlineControl = true as const;

// Page chrome consumes the same semantic operation from source and separately bundled plugins.
// The public adapter owns its author vocabulary; the host owns phone placement and row ordering.
Button.happierPageOperation = (
  props: ButtonProps,
  resolveText: HappierPageOperationTextResolver = value => value,
): HappierPageOperation | null => {
  const title = typeof props.children === 'string' ? props.children
    : resolveText(props.title, props.titleKey) ?? resolveText(props.accessibilityLabel, props.accessibilityLabelKey);
  if (!title?.trim()) return null;
  return {
    id: props.testID ?? title,
    title,
    ...(props.testID === undefined ? {} : { testID: props.testID }),
    ...(props.variant === 'destructive' ? { destructive: true } : {}),
    ...((props.variant ?? 'primary') === 'primary' ? { primary: true } : {}),
    ...(props.disabled ? { disabled: true } : {}),
    ...(props.busy ? { pending: true } : {}),
    onPress: props.onPress,
  };
};

/**
 * @internal The face of a labelled button: its chrome in every press state, the fill's finish, the
 * leading glyph and the label. `Button` draws it, and so does every built-in trigger drawn as a button
 * (a `Popover` with `triggerAppearance="primary"`), so a primary that opens a choice is the same
 * button as one that acts — one face, never a second button style.
 */
export function useButtonFace(variant: ButtonVariant, size: ButtonSize, disabled: boolean, joinedEdge?: 'start' | 'end') {
  const bindSurface = useThemeSurfaceBinder();
  const theme = usePluginTheme();
  const material = useHappierButtonMaterial(theme);
  const reducedMotion = useOptionalHappierUiAccessibility()?.reducedMotion ?? false;
  const palette = useOptionalHappierUiPalette(theme);
  const textEdge = useContext(HappierTextActionEdgeContext);
  const fill = useContext(PluginUiButtonFillContext);
  const { foreground } = resolveHappierButtonChrome({ theme, variant, disabled, focused: false, ...material });
  const labelColor = variant === 'destructive' ? theme.statusText?.danger ?? foreground : foreground;
  const style = (state: HappierPressableStyleState): HappierPortableStyle => {
    const chrome = resolveHappierButtonChrome({
      theme, variant, size, disabled: state.disabled, focused: state.focused,
      pressed: state.pressed, gloss: palette?.accentGloss, ...material,
      ...(joinedEdge === undefined ? {} : { joinedEdge }),
    });
    return {
      ...chrome.style,
      // A button never runs past its container: in a narrow pane its label wraps
      // instead of overflowing the card or the pane edge.
      flexShrink: 1,
      maxWidth: '100%',
      ...(fill ? { alignSelf: 'stretch', width: '100%' } : {}),
      // A button with no resting fill on a text edge puts its label on that edge, keeping its box (the hit area)
      // the same size. On its own line under a section's text the box moves into the leading gutter by the padding
      // it gave up; the offset is visual only (not a negative margin): the section measures this button's box to
      // choose between inline and stacked, and a margin-narrowed box wrapped the label and made the section flip
      // between the two. Ending a row (Select at the end of a phone's search row) the box stays where it is and
      // its padding moves to the leading side: a box moved past the trailing edge would scroll its row sideways.
      ...(textEdge === 'start' && variant === 'plain' && typeof chrome.style.paddingHorizontal === 'number'
        ? { position: 'relative', left: -(chrome.style.paddingHorizontal + (typeof chrome.style.borderWidth === 'number' ? chrome.style.borderWidth : 0)) }
        : {}),
      ...(textEdge === 'end' && variant === 'plain' && typeof chrome.style.paddingHorizontal === 'number'
        ? { paddingLeft: chrome.style.paddingHorizontal * 2, paddingRight: 0 }
        : {}),
      opacity: state.disabled && !state.busy ? chrome.disabledOpacity : 1,
      // The shared press vocabulary: a discrete control scales under the finger
      // (an opacity dip under reduced motion), eased on web.
      ...happierDiscretePressStyle(state.pressed && !state.disabled, reducedMotion),
      ...happierPressTransitionStyle(state.pressed, ['transform', 'opacity'], reducedMotion),
    };
  };
  const renderContent = (
    state: HappierPressableStyleState,
    content: Readonly<{ icon?: ReactNode; children: ReactNode; spinnerTestID?: string; singleLine?: boolean }>,
  ): ReactElement => {
    const surfaceState = resolveThemeSurfaceState('button', state);
    const rootSurface = bindSurface({ surface: 'button', part: 'root', state: surfaceState });
    const labelSurface = bindSurface({ surface: 'button', part: 'label', state: surfaceState });
    const iconSurface = bindSurface({ surface: 'button', part: 'icon', state: surfaceState });
    return <>
      <HappierSurfaceGradientLayer overrideBackgroundColor={rootSurface.style?.backgroundColor} gradient={resolveHappierButtonChrome({ theme, variant, disabled: state.disabled, focused: state.focused, pressed: state.pressed }).gradient} borderRadius={theme.radii.control} />
      {state.busy ? (
        <HappierSpinner
          size={iconMatchedSpinnerSize(theme.typography.label.fontSize)}
          color={foreground}
          testID={content.spinnerTestID}
        />
      ) : content.icon === undefined ? null : (
        <View {...{ dataSet: iconSurface.dataSet }} style={iconSurface.style}><PluginUiLeadingGlyphInkContext.Provider value={foreground}>{content.icon}</PluginUiLeadingGlyphInkContext.Provider></View>
      )}
      {/*
        The label keeps its box while busy instead of being replaced, so the
        button does not change width the moment it is pressed — a control
        that resizes under the pointer is the reason a second press lands
        somewhere else.
      */}
      <View style={state.busy ? { opacity: 0, flexShrink: 1 } : { flexShrink: 1 }}>
        {typeof content.children === 'string' || content.children === undefined ? (
          <HappierText {...{ dataSet: labelSurface.dataSet }} variant="label" {...(content.singleLine === true ? { numberOfLines: 1 } : {})} style={[{ color: labelColor, textAlign: 'center' }, labelSurface.style]}>
            {content.children}
          </HappierText>
        ) : content.children}
      </View>
    </>;
  };
  return { foreground, style, renderContent };
}

export type IconButtonProps = Readonly<{
  /** Icon-only controls always require an accessible action name. */
  accessibilityLabel: string;
  accessibilityLabelKey?: string;
  icon: ReactNode;
  disabled?: boolean;
  busy?: boolean;
  selected?: boolean;
  /** `well`: the round filled button a folded toolbar's Filters and ⋯ menus draw, for an action beside them. */
  appearance?: 'well';
  /** Logical focus target transferred by the mounted host after author state changes. */
  focusTarget?: PluginUiFocusTarget;
  testID?: string;

}> & (Readonly<{ action: PluginUiActionBinding<void>; onPress?: never }> | Readonly<{ action?: never; onPress: () => unknown }>);

/**
 * An icon button's fills (a well's rest, and every button's hover, press and open state): the control fill painted
 * through the containing material, so it stands on glass like the segmented control and search field beside it
 * when glass is on, and is the theme's control fill when it is off. IconButton and an icon Menu/Popover trigger
 * share it.
 */
export function usePluginIconButtonColors() {
  const theme = usePluginTheme();
  const paintColor = useHappierMaterialColorResolver();
  const control = paintColor(theme.colors.control);
  return { background: control, border: theme.colors.border, hover: control, pressed: control, selected: control, focus: theme.colors.focus };
}

/** The public icon-only adapter over the same press/pending owner as core. */
export function IconButton(props: IconButtonProps): ReactElement {
  const host = useOptionalPluginUiPresentationHost();
  if (props.action) {
    if (host?.renderActionIconButton) return host.renderActionIconButton(props);
    const { action, ...local } = props;
    return <IconButtonLocal {...local} disabled onPress={() => undefined} />;
  }
  return <IconButtonLocal {...props} />;
}

function IconButtonLocal({
  accessibilityLabel,
  accessibilityLabelKey,
  icon,
  disabled,
  busy,
  selected,
  appearance,
  focusTarget,
  testID,
  onPress,
}: Omit<IconButtonProps, 'action' | 'onPress'> & Readonly<{ onPress: () => unknown }>): ReactElement {
  const bindSurface = useThemeSurfaceBinder();
  const theme = usePluginTheme();
  const accessibleName = requireAccessibleButtonName(
    resolveAuthorText(usePluginTranslation(), accessibilityLabel, accessibilityLabelKey),
    undefined,
  );
  const well = appearance === 'well';
  const size = well ? HAPPIER_ICON_BUTTON_WELL_SIZE : HAPPIER_ICON_BUTTON_SIZE;
  const colors = usePluginIconButtonColors();
  const chrome = (state: HappierPressableStyleState) => resolveHappierIconButtonChrome({
    size, variant: well ? 'well' : 'plain', selected: state.selected, hovered: state.hovered,
    pressed: state.pressed, focused: state.focused, disabled: state.disabled && !state.busy, colors,
  });
  const focusBinding = usePluginUiFocusTargetBindingInternal(focusTarget);
  return (
    <HappierPressable
      accessibilityLabel={accessibleName}
      disabled={disabled}
      busy={busy}
      selected={selected}
      testID={testID}
      onPress={onPress}
      controlRef={focusBinding}
      style={(state) => ({ ...chrome(state).frame, width: size, height: size })}
    >
      {/* The frame is the drawn square's box; a finger's hit area reaches past it (HappierPressable). */}
      {(state) => {
        const surfaceState = resolveThemeSurfaceState('button', state);
        const rootSurface = bindSurface({ surface: 'button', part: 'root', state: surfaceState });
        const iconSurface = bindSurface({ surface: 'button', part: 'icon', state: surfaceState });
        return <View {...{ dataSet: rootSurface.dataSet }} style={[chrome(state).surface, rootSurface.style]}>
          <View {...{ dataSet: iconSurface.dataSet }} style={iconSurface.style}>{state.busy ? <HappierSpinner size="small" color={theme.colors.secondaryText} /> : icon}</View>
        </View>;
      }}
    </HappierPressable>
  );
}
