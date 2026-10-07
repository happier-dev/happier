import type { ReactNode } from 'react';
import { View } from 'react-native';

import type { HappierUiTheme } from '../../environment/types.js';
import { HappierSpinner } from '../feedback/Spinner.js';
import { HAPPIER_TONE_COLOR_TOKEN } from '../semantics.js';
import { HappierText } from '../text/Text.js';
import { HappierHeading } from './Foundation.js';
import type { HappierStyleProp } from '../portableTypes.js';
import { useHappierTypeRoleStyle } from '../text/typeRole.js';
import { softenHappierWorkColor } from '../work/workStatus.js';

/**
 * One step of a numbered story rail: a marker, a title with optional trailing
 * context, and the step's body.
 *
 * The marker is a count (① ② ③) or the settled state of a check-like fact.
 * It always sits on the raised control fill, so it stays visible on a dark
 * page, where a marker drawn on the page colour disappears.
 */
export type HappierStepMarker =
  | Readonly<{ kind: 'number'; value: number }>
  | Readonly<{
    kind: 'state';
    state: HappierStepState;
    /** What the state means, in words ("2 failing"). Required: a glyph alone says nothing. */
    label: string;
    /** A key from the author's translation bundle; `label` is its fallback. */
    labelKey?: string;
  }>;

export type HappierStepState = 'passed' | 'failed' | 'running';

/** The tone each state marker's glyph takes. */
export const HAPPIER_STEP_STATE_TONE = {
  passed: 'success',
  failed: 'danger',
  running: 'info',
} as const satisfies Record<HappierStepState, string>;

const MARKER_SIZE = 22;

/** Numbered setup and state/check rails share this marker; adapters supply their glyphs. */
export function HappierStepMarkerView(props: Readonly<{
  marker: HappierStepMarker;
  markerLabel?: string;
  stateGlyph?: ReactNode;
  numberState?: 'done' | 'current' | 'upcoming';
  theme: HappierUiTheme;
  testID?: string;
}>) {
  const { marker, theme } = props;
  const numberTextStyle = useHappierTypeRoleStyle('caption', theme);
  const current = marker.kind === 'number' && props.numberState === 'current';
  // A settled state sits on its own tone at the shared tint strength (a passed check on green, a failure on
  // red), so the rail reads its states before its words; a count stays on the raised control fill.
  const fill = marker.kind === 'state'
    ? softenHappierWorkColor(theme.colors[HAPPIER_TONE_COLOR_TOKEN[HAPPIER_STEP_STATE_TONE[marker.state]]], 0.1)
      ?? theme.colors.control
    : theme.colors.control;
  return <View testID={props.testID}
    {...(marker.kind === 'state' && props.markerLabel !== undefined
      ? { role: 'img' as const, 'aria-label': props.markerLabel, accessibilityLabel: props.markerLabel }
      : { 'aria-hidden': true })}
    style={{ width: MARKER_SIZE, height: MARKER_SIZE, borderRadius: MARKER_SIZE / 2,
      backgroundColor: fill, borderWidth: current ? 1.5 : 0,
      borderColor: theme.colors.text, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
    {marker.kind === 'number' ? (props.numberState === 'done' ? props.stateGlyph :
      <HappierText style={{ ...numberTextStyle, color: current ? theme.colors.text : theme.colors.secondaryText }}>{String(marker.value)}</HappierText>)
      : marker.state === 'running' ? <HappierSpinner size={12} color={theme.colors[HAPPIER_TONE_COLOR_TOKEN[HAPPIER_STEP_STATE_TONE.running]]} />
        : props.stateGlyph}
  </View>;
}

export function HappierStep(props: Readonly<{
  marker: HappierStepMarker;
  /** Resolved marker words for a state marker; the adapter translates them. */
  markerLabel?: string;
  /** The state glyph (check / close), supplied by the adapter's icon owner. */
  stateGlyph?: ReactNode;
  title: ReactNode;
  trailing?: ReactNode;
  children?: ReactNode;
  theme: HappierUiTheme;
  testID?: string;
  numberState?: 'done' | 'current' | 'upcoming';
  /** A core text-host binding, preserving plain instruction versus heading semantics. */
  titleContent?: ReactNode;
  style?: HappierStyleProp;
}>) {
  const theme = props.theme;
  const marker = props.marker;
  const markerId = props.testID === undefined ? undefined : `${props.testID}:marker`;

  return (
    <View testID={props.testID} style={[{ flexDirection: 'row', gap: theme.spacing.medium, alignItems: 'flex-start' }, props.style]}>
      <HappierStepMarkerView marker={marker} markerLabel={props.markerLabel} stateGlyph={props.stateGlyph}
        numberState={props.numberState} theme={theme} testID={markerId} />
      <View style={{ flex: 1, minWidth: 0, gap: theme.spacing.small }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.small, minHeight: MARKER_SIZE }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            {props.titleContent ?? <HappierHeading level={3} theme={theme}>{props.title}</HappierHeading>}
          </View>
          {props.trailing === undefined || props.trailing === null ? null : (
            <View style={{ flexShrink: 1, alignItems: 'flex-end' }}>{props.trailing}</View>
          )}
        </View>
        {props.children}
      </View>
    </View>
  );
}
