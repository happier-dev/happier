import { createContext, useContext, type ReactElement, type ReactNode } from 'react';
import { View } from 'react-native';
import { HappierSurfaceGradientLayer } from '../presentation/layout/SurfaceGradientLayer.js';
import { HappierSectionActionStackedContext } from '../presentation/layout/PageSection.js';

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
import { PluginUiLeadingGlyphInkContext } from './Icon.js';
/**
 * A state's action in a container that never owns its page's primary (the host's `stateActions: 'quiet'`): a
 * primary Button there draws quiet. Set by the shared state owner around its action slots, never a public prop.
 */
export const PluginUiQuietStateActionContext = createContext(false);
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

const BUTTON_HIT_SLOP = 8;

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
  const face = useButtonFace(quietState && variant === 'primary' ? 'secondary' : variant, size, disabled === true);

  return (
    <HappierPressable
      testID={testID}
      accessibilityLabel={accessibleName}
      disabled={disabled}
      busy={busy}
      hitSlop={BUTTON_HIT_SLOP}
      onPress={onPress}
      controlRef={focusBinding}
      style={face.style}
    >
      {(state) => face.renderContent(state, {
        icon,
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
export function useButtonFace(variant: ButtonVariant, size: ButtonSize, disabled: boolean) {
  const theme = usePluginTheme();
  const material = useHappierButtonMaterial(theme);
  const reducedMotion = useOptionalHappierUiAccessibility()?.reducedMotion ?? false;
  const palette = useOptionalHappierUiPalette(theme);
  const underSectionText = useContext(HappierSectionActionStackedContext);
  const { foreground } = resolveHappierButtonChrome({ theme, variant, disabled, focused: false, ...material });
  const style = (state: HappierPressableStyleState): HappierPortableStyle => {
    const chrome = resolveHappierButtonChrome({
      theme, variant, size, disabled: state.disabled, focused: state.focused,
      pressed: state.pressed, gloss: palette?.accentGloss, ...material,
    });
    return {
      ...chrome.style,
      // A button never runs past its container: in a narrow pane its label wraps
      // instead of overflowing the card or the pane edge.
      flexShrink: 1,
      maxWidth: '100%',
      // A button with no resting fill, on its own line under a section's text, puts its label on that
      // text's edge; its hover and press fill reach into the gutter by the padding it gave up. The offset is
      // visual only (not a negative margin): the section measures this button's box to choose between inline
      // and stacked, and a margin-narrowed box wrapped the label and made the section flip between the two.
      ...(underSectionText && variant === 'plain' && typeof chrome.style.paddingHorizontal === 'number'
        ? { position: 'relative', left: -(chrome.style.paddingHorizontal + (typeof chrome.style.borderWidth === 'number' ? chrome.style.borderWidth : 0)) }
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
    content: Readonly<{ icon?: ReactNode; children: ReactNode; spinnerTestID?: string }>,
  ): ReactElement => (
    <>
      <HappierSurfaceGradientLayer gradient={resolveHappierButtonChrome({ theme, variant, disabled: state.disabled, focused: state.focused, pressed: state.pressed }).gradient} borderRadius={theme.radii.control} />
      {state.busy ? (
        <HappierSpinner
          size={iconMatchedSpinnerSize(theme.typography.label.fontSize)}
          color={foreground}
          testID={content.spinnerTestID}
        />
      ) : content.icon === undefined ? null : (
        <PluginUiLeadingGlyphInkContext.Provider value={foreground}>{content.icon}</PluginUiLeadingGlyphInkContext.Provider>
      )}
      {/*
        The label keeps its box while busy instead of being replaced, so the
        button does not change width the moment it is pressed — a control
        that resizes under the pointer is the reason a second press lands
        somewhere else.
      */}
      <View style={state.busy ? { opacity: 0, flexShrink: 1 } : { flexShrink: 1 }}>
        {typeof content.children === 'string' || content.children === undefined ? (
          <HappierText variant="label" style={{ color: foreground, textAlign: 'center' }}>
            {content.children}
          </HappierText>
        ) : content.children}
      </View>
    </>
  );
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
  onPress: () => unknown;
}>;

/** The public icon-only adapter over the same press/pending owner as core. */
export function IconButton({
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
}: IconButtonProps): ReactElement {
  const theme = usePluginTheme();
  const accessibleName = requireAccessibleButtonName(
    resolveAuthorText(usePluginTranslation(), accessibilityLabel, accessibilityLabelKey),
    undefined,
  );
  const well = appearance === 'well';
  const size = well ? HAPPIER_ICON_BUTTON_WELL_SIZE : HAPPIER_ICON_BUTTON_SIZE;
  const chrome = (state: HappierPressableStyleState) => resolveHappierIconButtonChrome({
    size, variant: well ? 'well' : 'plain', selected: state.selected, hovered: state.hovered,
    pressed: state.pressed, focused: state.focused, disabled: state.disabled && !state.busy,
    colors: { background: theme.colors.control, border: theme.colors.border,
      hover: theme.colors.control, pressed: theme.colors.control,
      selected: theme.colors.control, focus: theme.colors.focus },
  });
  const focusBinding = usePluginUiFocusTargetBindingInternal(focusTarget);
  return (
    <HappierPressable
      accessibilityLabel={accessibleName}
      disabled={disabled}
      busy={busy}
      selected={selected}
      hitSlop={8}
      testID={testID}
      onPress={onPress}
      controlRef={focusBinding}
      style={(state) => ({ ...chrome(state).frame, width: size, height: size })}
    >
      {/* The frame is the drawn square's box; a finger's hit area reaches past it (HappierPressable). */}
      {(state) => <View style={chrome(state).surface}>
        {state.busy ? <HappierSpinner size="small" color={theme.colors.secondaryText} /> : icon}
      </View>}
    </HappierPressable>
  );
}
