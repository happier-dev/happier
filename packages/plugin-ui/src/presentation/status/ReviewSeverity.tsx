import { cloneElement, isValidElement, type ReactNode } from 'react';
import { View } from 'react-native';

import type { HappierUiTheme } from '../../environment/types.js';
import { useOptionalHappierUiTypography } from '../../environment/context.js';
import { HAPPIER_TONE_COLOR_TOKEN, resolveHappierToneTextColor, type HappierTone } from '../semantics.js';
import { HappierText } from '../text/Text.js';
import { resolveHappierTypeRoleStyle } from '../text/typeRole.js';

/** A review finding's severity, most severe first. */
export type HappierReviewSeverity =
  | 'blocker'
  | 'high'
  | 'medium'
  | 'low'
  | 'nit';

/** Most severe first: sort and count findings by this, keeping the reviewer's order within a severity. */
export const HAPPIER_REVIEW_SEVERITY_RANK = Object.freeze({
  blocker: 0,
  high: 1,
  medium: 2,
  low: 3,
  nit: 4,
} as const satisfies Record<HappierReviewSeverity, number>);

/**
 * The one colour role of each severity, wherever a finding is drawn (Happier's review surfaces and any
 * plugin listing findings). Only Blocker and High speak in the failure ink and Medium in the caution ink;
 * Low and Nit stay ink, a step apart, so the least important finding never borrows the accent that
 * means selection and focus.
 */
export const HAPPIER_REVIEW_SEVERITY_TONE = Object.freeze({
  blocker: 'danger',
  high: 'danger',
  medium: 'warning',
  low: 'secondary',
  nit: 'muted',
} as const satisfies Record<HappierReviewSeverity, HappierTone>);

/** The theme colour a severity is drawn in. */
export function resolveHappierReviewSeverityColor(
  theme: HappierUiTheme,
  severity: HappierReviewSeverity,
): string {
  return theme.colors[
    HAPPIER_TONE_COLOR_TOKEN[HAPPIER_REVIEW_SEVERITY_TONE[severity]]
  ];
}

/** The severity mark's measures: the label's dot and the contents rail's larger dot. */
export const HAPPIER_REVIEW_SEVERITY_METRICS = Object.freeze({
  labelDotPx: 6,
  railDotPx: 7,
  gapPx: 6,
});

export type HappierReviewSeveritySignProps = Readonly<{
  severity: HappierReviewSeverity;
  /**
   * The caller's words for the severity ("High", "2 medium"). A core adapter may pass its own text
   * element (a find-highlighted run); it is drawn in the severity's colour on the label's step.
   */
  label: ReactNode;
  theme: HappierUiTheme;
  /** `label` (default): "● High". `dot`: the mark alone, named by `accessibilityLabel`. */
  presentation?: 'label' | 'dot';
  accessibilityLabel?: string;
  testID?: string;
}>;

/**
 * How a finding's severity is drawn: its dot and its word, in its colour ("● High"), or the dot alone
 * on a contents row. Severity colour appears only on findings; every surface draws it here.
 */
export function HappierReviewSeveritySign(
  props: HappierReviewSeveritySignProps,
) {
  const typography = useOptionalHappierUiTypography();
  const color = resolveHappierReviewSeverityColor(props.theme, props.severity);
  const metrics = HAPPIER_REVIEW_SEVERITY_METRICS;
  if (props.presentation === 'dot') {
    return (
      <View
        testID={props.testID}
        accessibilityLabel={
          props.accessibilityLabel ??
          (typeof props.label === 'string' ? props.label : undefined)
        }
        style={{
          width: metrics.railDotPx,
          height: metrics.railDotPx,
          borderRadius: metrics.railDotPx / 2,
          backgroundColor: color,
        }}
      />
    );
  }
  const labelColor = resolveHappierToneTextColor(props.theme, HAPPIER_REVIEW_SEVERITY_TONE[props.severity]);
  const textStyle = {
    ...resolveHappierTypeRoleStyle('body', props.theme, typography, 'semiBold'),
    color: labelColor,
  };
  return (
    <View
      testID={props.testID}
      style={{ flexDirection: 'row', alignItems: 'center', gap: metrics.gapPx }}
    >
      <View
        style={{
          width: metrics.labelDotPx,
          height: metrics.labelDotPx,
          borderRadius: metrics.labelDotPx / 2,
          backgroundColor: color,
        }}
      />
      {isValidElement<{ style?: unknown }>(props.label) ? (
        cloneElement(props.label, {
          style: [props.label.props.style, { color: labelColor }],
        })
      ) : (
        <HappierText style={textStyle}>{props.label}</HappierText>
      )}
    </View>
  );
}
