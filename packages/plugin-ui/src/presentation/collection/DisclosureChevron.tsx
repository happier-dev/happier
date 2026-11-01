import type { ReactNode } from 'react';
import { View, type ViewStyle } from 'react-native';

import { HAPPIER_MOTION_V1 } from '../interaction/motion.js';

/**
 * The disclosure caret's geometry (lab `.wf-cv`): a 12pt chevron in a 24pt box whose hit area the caller extends
 * to the touch floor. The drawn mark is the lab caret's own proportion — a 6-unit run over 12 in a 24-unit glyph,
 * so each arm is √72/24 ≈ 0.354 of the glyph box — at the lab's 2.2-of-24 stroke (1.1pt at 12pt).
 */
export const HAPPIER_DISCLOSURE_CHEVRON_METRICS = Object.freeze({
  boxPx: 24,
  glyphPx: 12,
  armRatio: Math.SQRT2 / 4,
  strokePx: 1.1,
});

export type HappierChevronDirection = 'right' | 'down' | 'up' | 'left';

// The rotation of a corner drawn by its right and bottom strokes, per direction it points.
const CHEVRON_ROTATION_DEG: Readonly<Record<HappierChevronDirection, number>> =
  Object.freeze({
    right: -45,
    down: 45,
    left: 135,
    up: 225,
  });

type WebTransitionStyle = ViewStyle & {
  transitionProperty?: string;
  transitionDuration?: string;
  transitionTimingFunction?: string;
};

// A turn is the disclosure's own travel: the base duration on the one standard curve. A native host keeps the
// same end states without the CSS transition.
const TURN_TRANSITION: WebTransitionStyle = {
  transitionProperty: 'transform',
  transitionDuration: `${HAPPIER_MOTION_V1.baseMs}ms`,
  transitionTimingFunction: HAPPIER_MOTION_V1.standardEasingCss,
};

/**
 * The one drawn chevron of the portable layer: two strokes of a rotated corner, for surfaces whose icon
 * vocabulary has no caret (a plugin surface) and for the shared owners that draw their own disclosure (the
 * widget frame, a tree row, a Collection peek, a field box). A state change TURNS the same mark — the change
 * reads as one glyph moving, never a swapped icon. Decorative: the pressable around it owns the label and the
 * expanded state.
 */
export function HappierChevron(
  props: Readonly<{
    direction: HappierChevronDirection;
    color: string;
    /** The glyph box; each stroke of the corner is {@link HAPPIER_DISCLOSURE_CHEVRON_METRICS.armRatio} of it. */
    size?: number;
    reducedMotion?: boolean;
    testID?: string;
  }>,
) {
  const size = props.size ?? HAPPIER_DISCLOSURE_CHEVRON_METRICS.glyphPx;
  const arm = size * HAPPIER_DISCLOSURE_CHEVRON_METRICS.armRatio;
  const rotation = CHEVRON_ROTATION_DEG[props.direction];
  // A quarter arm back from the point keeps the drawn stroke optically centred in its box.
  const back = arm / 4;
  return (
    <View
      testID={props.testID}
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      pointerEvents="none"
      style={{
        width: size,
        height: size,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <View
        style={[
          {
            width: arm,
            height: arm,
            borderRightWidth: HAPPIER_DISCLOSURE_CHEVRON_METRICS.strokePx,
            borderBottomWidth: HAPPIER_DISCLOSURE_CHEVRON_METRICS.strokePx,
            borderColor: props.color,
            // Every direction lists the same transform functions, so the web transition turns the one stroke
            // instead of interpolating an unrelated matrix.
            transform: [
              {
                translateX:
                  props.direction === 'right'
                    ? -back
                    : props.direction === 'left'
                      ? back
                      : 0,
              },
              {
                translateY:
                  props.direction === 'down'
                    ? -back
                    : props.direction === 'up'
                      ? back
                      : 0,
              },
              { rotate: `${rotation}deg` },
            ],
          },
          props.reducedMotion ? null : TURN_TRANSITION,
        ]}
      />
    </View>
  );
}

/**
 * The disclosure turn: a glyph pointing at the row (right) while collapsed turns a quarter toward what it revealed
 * (down) while expanded, on the base duration and standard curve; reduced motion keeps the end states without the
 * travel. Hosts with an icon vocabulary bind their own right-pointing caret here, so every disclosure — the drawn
 * chevron below and a host's icon caret — shares one rule. Decorative: the pressable around it owns the label and
 * the expanded state.
 */
export function HappierDisclosureTurn(
  props: Readonly<{
    expanded: boolean;
    reducedMotion?: boolean;
    testID?: string;
    children: ReactNode;
  }>,
) {
  return (
    <View
      testID={props.testID}
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      pointerEvents="none"
      style={[
        { transform: [{ rotate: props.expanded ? '90deg' : '0deg' }] },
        props.reducedMotion ? null : TURN_TRANSITION,
      ]}
    >
      {props.children}
    </View>
  );
}

/** A disclosure points to what it reveals: right while collapsed, down while expanded. */
export function HappierDisclosureChevron(
  props: Readonly<{
    expanded: boolean;
    color: string;
    size?: number;
    reducedMotion?: boolean;
    testID?: string;
  }>,
) {
  return (
    <HappierDisclosureTurn expanded={props.expanded} reducedMotion={props.reducedMotion} testID={props.testID}>
      <HappierChevron direction="right" color={props.color} size={props.size} reducedMotion />
    </HappierDisclosureTurn>
  );
}
