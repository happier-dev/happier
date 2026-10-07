import type { HappierUiTheme } from '../../environment/types.js';
import { HAPPIER_DEFAULT_MINIMUM_INTERACTIVE_TARGET_SIZE } from '../../environment/interactiveTarget.js';
import type { HappierPortableStyle } from '../portableTypes.js';
import { happierRaisedEdgeStyle, settleHappierRaisedEdge, type HappierRaisedEdge } from '../layout/raisedEdge.js';
import { happierFocusRingStyle } from './focusVisible.js';

export type HappierButtonChromeVariant = 'primary' | 'secondary' | 'plain' | 'destructive';

/**
 * `normal` is the page action (the shared 44 pt target everywhere). `small` is an action inside a dense
 * pointer layout — a row's peek, a card, a detail header — drawn at the host's desktop control height;
 * on a native touch platform it never drops under that platform's touch floor.
 */
export type HappierButtonChromeSize = 'normal' | 'small';

/** The dense pointer control height (the lab's and the host's desktop button, `.btn`). */
export const HAPPIER_SMALL_BUTTON_HEIGHT = 32;

const BUTTON_PADDING_VERTICAL = 8;
/** The button's edge: transparent, it carries the primary fill's gloss line on its top side. */
const BUTTON_EDGE_WIDTH = 2;
export const HAPPIER_BUTTON_DISABLED_OPACITY = 0.35;

/**
 * The one chrome of a button-shaped control: geometry, fill, focus ring and
 * label colour for each variant. `Button` renders it, and so does a menu whose
 * trigger is the page's primary action ("Add a source ▾"), so the two can never
 * drift into two looks for the same action weight. Press feedback stays with
 * each caller's pressable, which already owns it.
 */
export function resolveHappierButtonChrome(input: Readonly<{
  theme: HappierUiTheme;
  variant: HappierButtonChromeVariant;
  disabled: boolean;
  focused: boolean;
  size?: HappierButtonChromeSize;
  /** The native touch floor (`useHappierNativeMinimumInteractiveTargetSize`); undefined on pointer platforms. */
  nativeMinimumTarget?: number;
  /** Pressed this frame: a primary button's gloss goes flat under the finger. */
  pressed?: boolean;
  /** The host's accent gloss (`HappierUiPalette.accentGloss`), the light top line of the primary fill. */
  gloss?: HappierRaisedEdge | null;
}>): Readonly<{ style: HappierPortableStyle; foreground: string }> {
  const { theme, variant } = input;
  const small = input.size === 'small';
  const foreground = variant === 'primary' ? theme.colors.onAccent
    : variant === 'destructive' ? theme.colors.danger : theme.colors.text;
  const background = variant === 'plain'
    ? 'transparent'
    : input.disabled
      ? theme.colors.controlDisabled
      : (variant === 'primary' ? theme.colors.accent : theme.colors.control);
  return {
    foreground,
    style: {
      minHeight: small
        ? Math.max(HAPPIER_SMALL_BUTTON_HEIGHT, input.nativeMinimumTarget ?? 0)
        : HAPPIER_DEFAULT_MINIMUM_INTERACTIVE_TARGET_SIZE,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: small ? theme.spacing.xsmall : theme.spacing.small,
      paddingHorizontal: small ? theme.spacing.medium : theme.spacing.large,
      paddingVertical: small ? 0 : BUTTON_PADDING_VERTICAL,
      borderRadius: theme.radii.control,
      backgroundColor: background,
      borderWidth: BUTTON_EDGE_WIDTH,
      borderColor: 'transparent',
      ...happierFocusRingStyle({ visible: input.focused, color: theme.colors.focus }),
      ...(variant === 'primary'
        ? happierRaisedEdgeStyle(settleHappierRaisedEdge(input.gloss, {
          disabled: input.disabled,
          focused: input.focused,
          pressed: input.pressed === true,
        }))
        : null),
    },
  };
}
