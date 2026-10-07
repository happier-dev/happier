import { Platform, type ViewStyle } from 'react-native';

import type { HappierPortableStyle } from '../portableTypes.js';
import { HAPPIER_MOTION_V1 } from './motion.js';

/**
 * The one press-feedback vocabulary for Happier core and plugin surfaces.
 *
 * Happier core's `motionTokens.press` and its press/release durations read
 * these values rather than restating them, so a plugin row and a host row dip
 * by the same amount at the same speed.
 *
 * - `scale`: tactile press for discrete controls (never below 0.95).
 * - `opacity`: the standard pressed dip (icons, glyphs, compact controls).
 * - `opacitySubtle`: the gentler dip for large text-led rows, where a
 *   full-strength dip would flash the whole surface. Rows never scale.
 * - `opacitySurface`: near-static acknowledgement for whole elevated cards.
 * - `pressMs` / `releaseMs`: press is fast enough to feel immediate under the
 *   finger; release is slower so a cancelled press eases back.
 */
export const HAPPIER_PRESS_FEEDBACK_V1 = Object.freeze({
  scale: 0.97,
  opacity: 0.7,
  opacitySubtle: 0.85,
  opacitySurface: 0.985,
  pressMs: 120,
  releaseMs: 180,
  easingCss: HAPPIER_MOTION_V1.standardEasingCss,
});

type WebTransitionStyle = ViewStyle & {
  transitionProperty?: string;
  transitionDuration?: string;
  transitionTimingFunction?: string;
};

/**
 * Web-only interruptible transition for a pressable's own state paint.
 *
 * A CSS transition retargets from the current value, so a press that is
 * released mid-dip eases back rather than restarting. The pressed frame uses
 * the press duration and every other frame the release duration, which is the
 * asymmetry the tokens describe. Native keeps the platform's immediate state
 * paint; it returns nothing there. `properties` names the exact properties
 * that change — never `all`.
 */
export function happierPressTransitionStyle(
  pressed: boolean,
  properties: readonly ('opacity' | 'transform' | 'background-color')[],
  reducedMotion = false,
): HappierPortableStyle | undefined {
  if (Platform.OS !== 'web' || properties.length === 0) return undefined;
  const animated = reducedMotion ? properties.filter((property) => property !== 'transform') : properties;
  const transition: WebTransitionStyle = {
    transitionProperty: animated.join(', '),
    transitionDuration: `${pressed ? HAPPIER_PRESS_FEEDBACK_V1.pressMs : HAPPIER_PRESS_FEEDBACK_V1.releaseMs}ms`,
    transitionTimingFunction: HAPPIER_PRESS_FEEDBACK_V1.easingCss,
  };
  // Web-only CSS transition keys are outside the curated portable vocabulary on
  // purpose (authors cannot set them); React Native Web applies them, and this
  // owner returns them only on web.
  return transition as HappierPortableStyle;
}

/**
 * The tactile press for a discrete control (a button): it scales, it does not
 * dim. Reduced motion keeps the acknowledgement as the standard opacity dip.
 * `transform` is outside the portable author vocabulary on purpose; this owner
 * is the one place shared controls ask for it.
 */
export function happierDiscretePressStyle(
  pressed: boolean,
  reducedMotion: boolean,
): HappierPortableStyle | undefined {
  if (!pressed) return undefined;
  if (reducedMotion) return { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacity };
  const scaled: ViewStyle = { transform: [{ scale: HAPPIER_PRESS_FEEDBACK_V1.scale }] };
  return scaled as HappierPortableStyle;
}
