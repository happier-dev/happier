import type { HappierPortableStyle } from '../portableTypes.js';
import { HAPPIER_FOCUS_RING_DELEGATED_STYLE, happierFocusRingStyle } from './focusVisible.js';

export const HAPPIER_ICON_BUTTON_SIZE = 28;

/** The shared visible icon-control frame; adapters supply their semantic theme colors. */
export function resolveHappierIconButtonChrome(input: Readonly<{
  size: number;
  variant: 'plain' | 'outlined';
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
      backgroundColor: input.pressed ? input.colors.pressed
        : input.hovered ? input.colors.hover
          : input.selected && input.selectedBackground !== false ? input.colors.selected
            : input.variant === 'outlined' ? input.colors.background : undefined,
      ...(input.disabled ? { opacity: 0.5 } : {}),
      // The frame is the hit box; the ring belongs to the drawn circle (`surface`).
      ...HAPPIER_FOCUS_RING_DELEGATED_STYLE,
    },
    surface: {
      width: input.size,
      height: input.size,
      borderRadius: input.size / 2,
      alignItems: 'center',
      justifyContent: 'center',
      ...(input.variant === 'outlined' ? { borderWidth: 1, borderColor: input.colors.border } : {}),
      ...happierFocusRingStyle({ visible: input.focused, color: input.colors.focus }),
    },
  };
}
