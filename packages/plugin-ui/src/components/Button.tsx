import type { ReactElement, ReactNode } from 'react';
import { View } from 'react-native';

import { HAPPIER_DEFAULT_MINIMUM_INTERACTIVE_TARGET_SIZE } from '../environment/interactiveTarget.js';
import { HappierPressable, type HappierPressableStyleState } from '../presentation/interaction/Pressable.js';
import type { HappierPortableStyle } from '../presentation/portableTypes.js';
import { HAPPIER_TONE_COLOR_TOKEN } from '../presentation/semantics.js';
import { HappierSpinner, iconMatchedSpinnerSize } from '../presentation/feedback/Spinner.js';
import { HappierText } from '../presentation/text/Text.js';
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
 */
export type ButtonVariant = 'primary' | 'secondary' | 'plain';

type ButtonCommonProps = Readonly<{
  /** Literal label. It provides the accessible name when no override is supplied. */
  title?: string;
  /** A key from this plugin's declared translation bundle; `title` is its fallback. */
  titleKey?: string;
  /** A translation key for an explicit accessible-name override. */
  accessibilityLabelKey?: string;
  variant?: ButtonVariant;
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

const BUTTON_PADDING_VERTICAL = 8;
const BUTTON_PRESSED_OPACITY = 0.9;
const BUTTON_DISABLED_OPACITY = 0.35;
const BUTTON_HIT_SLOP = 8;
const BUTTON_FOCUS_RING_WIDTH = 2;

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

  const foreground = variant === 'primary'
    ? theme.colors.onAccent
    : theme.colors[HAPPIER_TONE_COLOR_TOKEN.neutral];

  const background = variant === 'plain'
    ? 'transparent'
    : disabled === true
      ? theme.colors.controlDisabled
      : (variant === 'primary' ? theme.colors.accent : theme.colors.control);

  const resolveStyle = (state: HappierPressableStyleState): HappierPortableStyle => ({
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.small,
    paddingHorizontal: theme.spacing.large,
    paddingVertical: BUTTON_PADDING_VERTICAL,
    borderRadius: theme.radii.control,
    backgroundColor: background,
    // A focus ring is drawn as a border rather than an outline so the control
    // keeps its box on every platform React Native renders to.
    borderWidth: BUTTON_FOCUS_RING_WIDTH,
    borderColor: state.focused ? theme.colors.focus : 'transparent',
    opacity: state.disabled && !state.busy
      ? BUTTON_DISABLED_OPACITY
      : (state.pressed ? BUTTON_PRESSED_OPACITY : 1),
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
  const size = Math.max(
    HAPPIER_DEFAULT_MINIMUM_INTERACTIVE_TARGET_SIZE,
    theme.typography.label.lineHeight + theme.spacing.large * 2,
  );
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
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 2,
        borderColor: state.focused ? theme.colors.focus : 'transparent',
        backgroundColor: state.selected ? theme.colors.control : 'transparent',
        opacity: state.disabled && !state.busy ? 0.35 : state.pressed ? 0.8 : 1,
      })}
    >
      {(state) => state.busy
        ? <HappierSpinner size="small" color={theme.colors.secondaryText} />
        : icon}
    </HappierPressable>
  );
}
