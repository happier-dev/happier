import { View, type ViewStyle } from 'react-native';

import type { HappierUiTheme } from '../../environment/types.js';
import type { HappierStyleProp } from '../portableTypes.js';

/** The mark's outer diameter and its two ring weights (lab `.fm-rd`). */
export const HAPPIER_RADIO_MARK_METRICS = Object.freeze({
  size: 16,
  ringWidth: 1.5,
  selectedRingWidth: 5,
});

/**
 * The mark's geometry and ink for owners that hold colours rather than a whole theme (a tile grid's
 * own palette). `HappierRadioMark` draws exactly this, so every single-choice mark is one drawing.
 */
export function resolveHappierRadioMarkStyle(input: Readonly<{
  selected: boolean;
  /** The chosen ring's colour (ink). */
  ink: string;
  /** The unchosen ring's colour. */
  quiet: string;
  /** The centre: the surface the mark stands on. */
  surface: string;
  disabled?: boolean;
}>): ViewStyle {
  const { size, ringWidth, selectedRingWidth } = HAPPIER_RADIO_MARK_METRICS;
  return {
    width: size,
    height: size,
    borderRadius: size / 2,
    borderWidth: input.selected ? selectedRingWidth : ringWidth,
    borderColor: input.selected ? input.ink : input.quiet,
    backgroundColor: input.surface,
    opacity: input.disabled ? 0.4 : 1,
    flexShrink: 0,
  };
}

/**
 * The one single-choice mark: a quiet ring that fills to an ink ring with a light centre when chosen. It
 * is decorative — the row or option that carries it owns the `radio` role, the checked state and the
 * keyboard — so it is hidden from assistive technology. A Collection table's leading choice column, a
 * Keep/region option list and an author's own radio rows all draw this one mark.
 *
 * Choosing is a high-frequency, direct action, so the mark changes at once (no animation of its own).
 */
export function HappierRadioMark(
  props: Readonly<{
    selected: boolean;
    disabled?: boolean;
    theme: HappierUiTheme;
    testID?: string;
    style?: HappierStyleProp;
  }>,
) {
  return (
    <View
      testID={props.testID}
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={[
        resolveHappierRadioMarkStyle({
          selected: props.selected,
          ink: props.theme.colors.text,
          quiet: props.theme.colors.mutedText,
          surface: props.theme.colors.surface,
          disabled: props.disabled,
        }),
        props.style,
      ]}
    />
  );
}
