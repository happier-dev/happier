import type { HappierPortableStyle } from '../portableTypes.js';
import { HAPPIER_FOCUS_RING_DELEGATED_STYLE, happierFocusRingStyle } from './focusVisible.js';

export const HAPPIER_ICON_BUTTON_SIZE = 28;
/** How far a plain icon button's box reaches past its drawn glyph on each side: a trailing button's glyph, not its box, ends on its row's edge, and a label that takes the button's place keeps that edge too. */
export const HAPPIER_ICON_BUTTON_HIT_PAD = 4;
/** A `well` is the object on its row (the phone toolbar's Filters and ⋯ beside the search), not a glyph in a rail. */
export const HAPPIER_ICON_BUTTON_WELL_SIZE = 34;

/**
 * `plain` is a rounded square with no resting fill (toolbars, rails, headers, menus); `outlined` is a round
 * bordered well; `well` is a round resting fill whose fill is its own edge (a call's Mute · End, a phone
 * toolbar's Filters and ⋯).
 */
export type HappierIconButtonVariant = 'plain' | 'outlined' | 'well';

/**
 * An icon button's corner: a `plain` button (toolbars, rails, headers, menus) is a rounded square whose
 * radius grows with its size (labs app-surfaces xrail, glass W1, lane12-final: 28→8, 36→10); the
 * other variants stay round.
 */
export function resolveHappierIconButtonRadius(size: number, variant: HappierIconButtonVariant): number {
  return variant === 'plain' ? Math.round(size * 0.28) : size / 2;
}

/**
 * The shared visible icon-control chrome; adapters supply their semantic theme colors.
 *
 * `frame` is the press target and nothing else: it may be larger than the drawn square (a touch
 * floor), so it never paints. Fill, hover, press and selection all live on `surface`, the drawn
 * square, as does the keyboard focus ring — the control never looks bigger than it is.
 */
export function resolveHappierIconButtonChrome(input: Readonly<{
  size: number;
  variant: HappierIconButtonVariant;
  selected: boolean;
  selectedBackground?: boolean;
  hovered: boolean;
  pressed: boolean;
  focused: boolean;
  disabled: boolean;
  colors: Readonly<{
    background: string;
    border: string;
    hover: string;
    pressed: string;
    selected: string;
    focus: string;
  }>;
}>): Readonly<{ frame: HappierPortableStyle; surface: HappierPortableStyle }> {
  return {
    frame: {
      alignItems: 'center',
      justifyContent: 'center',
      ...(input.disabled ? { opacity: 0.5 } : {}),
      // The frame is the hit box; the ring belongs to the drawn square (`surface`).
      ...HAPPIER_FOCUS_RING_DELEGATED_STYLE,
    },
    surface: {
      width: input.size,
      height: input.size,
      borderRadius: resolveHappierIconButtonRadius(input.size, input.variant),
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: input.pressed ? input.colors.pressed
        : input.hovered ? input.colors.hover
          : input.selected && input.selectedBackground !== false ? input.colors.selected
            : input.variant === 'plain' ? undefined : input.colors.background,
      ...(input.variant === 'outlined' ? { borderWidth: 1, borderColor: input.colors.border } : {}),
      ...happierFocusRingStyle({ visible: input.focused, color: input.colors.focus }),
    },
  };
}
