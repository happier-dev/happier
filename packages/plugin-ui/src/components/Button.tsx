import type { ReactElement, ReactNode } from 'react';
import { View } from 'react-native';

import { useOptionalHappierUiAccessibility, useOptionalHappierUiPalette } from '../environment/context.js';
import { HappierPressable, type HappierPressableStyleState } from '../presentation/interaction/Pressable.js';
import {
  happierDiscretePressStyle,
  happierPressTransitionStyle,
} from '../presentation/interaction/pressFeedback.js';
import type { HappierPortableStyle } from '../presentation/portableTypes.js';
import {
  HAPPIER_BUTTON_DISABLED_OPACITY,
  resolveHappierButtonChrome,
} from '../presentation/interaction/buttonChrome.js';
import { HappierSpinner, iconMatchedSpinnerSize } from '../presentation/feedback/Spinner.js';
import { HappierText } from '../presentation/text/Text.js';
import { HAPPIER_ICON_BUTTON_SIZE, resolveHappierIconButtonChrome } from '../presentation/interaction/iconButtonChrome.js';
import { useHappierNativeMinimumInteractiveTargetSize } from '../environment/interactiveTarget.js';
import {
  type PluginUiFocusTarget,
  usePluginUiFocusTargetBindingInternal,
} from './Focus.js';
import { usePluginTheme, usePluginTranslation } from './PluginUiProvider.js';
import { resolveAuthorText } from './resolveAuthorText.js';

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
  const theme = usePluginTheme();
  const translate = usePluginTranslation();
  const label = resolveAuthorText(translate, title, titleKey);
  const resolvedAccessibilityLabel = resolveAuthorText(
    translate,
    accessibilityLabel,
    accessibilityLabelKey,
  );
  const accessibleName = requireAccessibleButtonName(resolvedAccessibilityLabel, label);
  const focusBinding = usePluginUiFocusTargetBindingInternal(focusTarget);

  const reducedMotion = useOptionalHappierUiAccessibility()?.reducedMotion ?? false;
  const palette = useOptionalHappierUiPalette(theme);
  const nativeMinimumTarget = useHappierNativeMinimumInteractiveTargetSize();
  const { foreground } = resolveHappierButtonChrome({ theme, variant, disabled: disabled === true, focused: false });
  const resolveStyle = (state: HappierPressableStyleState): HappierPortableStyle => ({
    ...resolveHappierButtonChrome({
      theme, variant, size, nativeMinimumTarget, disabled: disabled === true, focused: state.focused,
      pressed: state.pressed, gloss: palette?.accentGloss,
    }).style,
    opacity: state.disabled && !state.busy ? HAPPIER_BUTTON_DISABLED_OPACITY : 1,
    // The shared press vocabulary: a discrete control scales under the finger
    // (an opacity dip under reduced motion), eased on web.
    ...happierDiscretePressStyle(state.pressed && !state.disabled, reducedMotion),
    ...happierPressTransitionStyle(state.pressed, ['transform', 'opacity'], reducedMotion),
  });

  return (
    <HappierPressable
      testID={testID}
      accessibilityLabel={accessibleName}
      disabled={disabled}
      busy={busy}
      hitSlop={BUTTON_HIT_SLOP}
      onPress={onPress}
      controlRef={focusBinding}
      style={resolveStyle}
    >
      {(state) => (
        <>
          {state.busy ? (
            <HappierSpinner
              size={iconMatchedSpinnerSize(theme.typography.label.fontSize)}
              color={foreground}
              testID={testID ? `${testID}-spinner` : undefined}
            />
          ) : icon}
          {/*
            The label keeps its box while busy instead of being replaced, so the
            button does not change width the moment it is pressed — a control
            that resizes under the pointer is the reason a second press lands
            somewhere else.
          */}
          <View style={state.busy ? { opacity: 0 } : undefined}>
            {children ?? (
              <HappierText variant="label" style={{ color: foreground }}>
                {label}
              </HappierText>
            )}
          </View>
        </>
      )}
    </HappierPressable>
  );
}

export type IconButtonProps = Readonly<{
  /** Icon-only controls always require an accessible action name. */
  accessibilityLabel: string;
  accessibilityLabelKey?: string;
  icon: ReactNode;
  disabled?: boolean;
  busy?: boolean;
  selected?: boolean;
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
  focusTarget,
  testID,
  onPress,
}: IconButtonProps): ReactElement {
  const theme = usePluginTheme();
  const accessibleName = requireAccessibleButtonName(
    resolveAuthorText(usePluginTranslation(), accessibilityLabel, accessibilityLabelKey),
    undefined,
  );
  const size = HAPPIER_ICON_BUTTON_SIZE;
  const minimumTarget = useHappierNativeMinimumInteractiveTargetSize() ?? size;
  const chrome = (state: HappierPressableStyleState) => resolveHappierIconButtonChrome({
    size, variant: 'plain', selected: state.selected, hovered: state.hovered,
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
      style={(state) => ({
        ...chrome(state).frame,
        minWidth: minimumTarget,
        minHeight: minimumTarget,
        borderRadius: size / 2,
      })}
    >
      {/* Press state belongs to the outer frame; the visible focus surface reads only focus. */}
      {(state) => <View style={chrome({ ...state, pressed: false }).surface}>
        {state.busy ? <HappierSpinner size="small" color={theme.colors.secondaryText} /> : icon}
      </View>}
    </HappierPressable>
  );
}
