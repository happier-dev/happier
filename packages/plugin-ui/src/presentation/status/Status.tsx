import { cloneElement, isValidElement, type ReactNode } from 'react';
import { View, type TextStyle } from 'react-native';

import type { HappierUiAccessibility, HappierUiTheme } from '../../environment/types.js';
import type { HappierAccessibilityLiveRegion, HappierFocusable, HappierPortableStyle } from '../portableTypes.js';
import { useOptionalHappierUiAccessibility } from '../../environment/context.js';
import { HAPPIER_TONE_COLOR_TOKEN, type HappierTone } from '../semantics.js';
import { HappierText } from '../text/Text.js';
import { HappierStatusDot } from './StatusDot.js';

export type HappierStatusProps = Readonly<{
  /** Visible status name. A core adapter may supply its scaled text primitive. */
  label: ReactNode;
  /** Optional current value below the status name. */
  value?: ReactNode;
  tone: HappierTone;
  /** Resolved semantic theme facts supplied by the current host. */
  theme: HappierUiTheme;
  /**
   * Resolved host contrast fact for consumers that do not mount the executable
   * Plugin UI environment (the declarative renderer). An installed environment
   * remains the source for ordinary Plugin UI surfaces.
   */
  contrast?: HappierUiAccessibility['contrast'];
  /** Whether the status is currently active/in flight. */
  isPulsing?: boolean;
  /** Host-owned retained-surface activity; false pauses native pulse work. */
  animationEnabled?: boolean;
  /** Private semantic focus binding supplied by the public Status adapter. */
  controlRef?: (instance: HappierFocusable | null) => void;
  testID?: string;
  /** Hosts control whether a dynamically changing status should announce. */
  accessibilityLiveRegion?: HappierAccessibilityLiveRegion;
  /**
   * The complete meaning of this status, in words, for the one status region.
   *
   * Tone is a colour. An adapter whose vocabulary lets the semantic state live
   * in `tone` while `label`/`value` stay neutral supplies the composed wording
   * here, so assistive technology receives what a sighted user sees. The public
   * executable `Status` already requires `label` to say it, and passes nothing.
   */
  accessibilityLabel?: string;
}>;

function textStyle(
  theme: HappierUiTheme,
  variant: 'label' | 'body',
  color: string,
): HappierPortableStyle {
  const typography = theme.typography[variant];
  return {
    fontSize: typography.fontSize,
    lineHeight: typography.lineHeight,
    fontWeight: typography.fontWeight as TextStyle['fontWeight'],
    color,
  };
}

/**
 * The shared semantic status row for executable Plugin UI and declarative
 * rendering. It owns the status role, announcement policy, tone-to-dot mapping
 * and row layout. A core adapter may pass its existing scaled `Text` elements
 * as slots, while string slots use the portable text owner directly.
 */
export function HappierStatus(props: HappierStatusProps) {
  const environmentAccessibility = useOptionalHappierUiAccessibility();
  const accessibilityLiveRegion = props.accessibilityLiveRegion ?? 'polite';
  const ariaLive = accessibilityLiveRegion === 'none' ? 'off' : accessibilityLiveRegion;
  const highContrast = (props.contrast ?? environmentAccessibility?.contrast) === 'high';
  const toneColor = props.theme.colors[HAPPIER_TONE_COLOR_TOKEN[props.tone]];
  const label = renderStatusText(
    props.label,
    textStyle(props.theme, 'label', props.theme.colors.text),
  );
  const value = props.value === undefined
    ? null
    : renderStatusText(
      props.value,
      textStyle(props.theme, 'body', highContrast ? props.theme.colors.text : toneColor),
      true,
      highContrast ? { color: props.theme.colors.text } : undefined,
    );

  return (
    <View
      ref={props.controlRef}
      role="status"
      tabIndex={props.controlRef ? -1 : undefined}
      testID={props.testID}
      {...(props.accessibilityLabel === undefined
        ? {}
        : { accessibilityLabel: props.accessibilityLabel, 'aria-label': props.accessibilityLabel })}
      accessibilityLiveRegion={accessibilityLiveRegion}
      aria-live={ariaLive}
      style={{ flexDirection: 'row', alignItems: 'center', gap: props.theme.spacing.small }}
    >
      <HappierStatusDot
        color={toneColor}
        isPulsing={props.isPulsing}
        animationEnabled={props.animationEnabled}
        {...(highContrast ? {
          size: 8,
          style: { borderWidth: 1, borderColor: props.theme.colors.text },
        } : {})}
      />
      <View style={{ flex: 1, minWidth: 0, gap: props.theme.spacing.xsmall }}>
        {label}
        {value}
      </View>
    </View>
  );
}

function renderStatusText(
  value: ReactNode,
  style: HappierPortableStyle,
  selectable = false,
  elementStyleOverride?: HappierPortableStyle,
): ReactNode {
  if (isValidElement<{ style?: unknown }>(value)) {
    return elementStyleOverride === undefined
      ? value
      : cloneElement(value, { style: [value.props.style, elementStyleOverride] });
  }
  return <HappierText selectable={selectable} style={style}>{value}</HappierText>;
}
