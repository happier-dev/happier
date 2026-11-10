import type { ReactNode } from 'react';
import { View } from 'react-native';

import type { HappierUiTheme } from '../../environment/types.js';
import { HappierSpinner } from '../feedback/Spinner.js';
import { HAPPIER_TONE_COLOR_TOKEN, type HappierTone } from '../semantics.js';
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

/** `open`: a chapter with nothing settled yet (no fix linked); a hollow mark, neither a count nor a verdict. */
export type HappierStepState = 'passed' | 'failed' | 'running' | 'open';

/** The tone each state marker's glyph takes. */
export const HAPPIER_STEP_STATE_TONE = {
  passed: 'success',
  failed: 'danger',
  running: 'info',
  open: 'secondary',
} as const satisfies Record<HappierStepState, string>;

const MARKER_SIZE = 22;
const MARKER_GLYPH_SIZE = 12;
/** The narrowest a step's words get beside its action before the action moves beneath them. */
const STEP_TEXT_MIN_WIDTH_BESIDE_ACTION = 240;

/**
 * Where one ordered step stands. `current` is the step in front of the reader; `running` is a step
 * the system is working on (it spins and reads busy); `waiting` needs the reader before it can go on.
 */
export type HappierStepProgress = 'upcoming' | 'current' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';

/** The progress states that settle on a glyph the adapter's icon owner draws, and the tone each takes on the rail. */
export const HAPPIER_STEP_PROGRESS_GLYPH_TONE = {
  done: 'success',
  failed: 'danger',
  waiting: 'attention',
} as const satisfies Partial<Record<HappierStepProgress, HappierTone>>;

/** Numbered setup and state/check rails share this marker; adapters supply their glyphs. */
export function HappierStepMarkerView(props: Readonly<{
  marker: HappierStepMarker;
  markerLabel?: string;
  stateGlyph?: ReactNode;
  numberState?: HappierStepProgress;
  theme: HappierUiTheme;
  testID?: string;
}>) {
  const { marker, theme } = props;
  const numberTextStyle = useHappierTypeRoleStyle('micro', theme);
  const progress = marker.kind === 'number' ? props.numberState ?? 'upcoming' : null;
  const ringed = progress === 'current' || progress === 'running';
  const settledTone = progress === 'failed' || progress === 'waiting' ? HAPPIER_STEP_PROGRESS_GLYPH_TONE[progress] : null;
  // A settled state sits on its own tone at the shared tint strength (a passed check on green, a failure on
  // red), so the rail reads its states before its words; a count stays on the raised control fill.
  const fill = marker.kind === 'state' && marker.state === 'open' ? theme.colors.control
    : marker.kind === 'state'
    ? softenHappierWorkColor(theme.colors[HAPPIER_TONE_COLOR_TOKEN[HAPPIER_STEP_STATE_TONE[marker.state]]], 0.1)
      ?? theme.colors.control
    : settledTone ? softenHappierWorkColor(theme.colors[HAPPIER_TONE_COLOR_TOKEN[settledTone]], 0.1) ?? theme.colors.control
      : theme.colors.control;
  return <View testID={props.testID}
    {...(marker.kind === 'state' && props.markerLabel !== undefined
      ? { role: 'img' as const, 'aria-label': props.markerLabel, accessibilityLabel: props.markerLabel }
      : { 'aria-hidden': true })}
    style={{ width: MARKER_SIZE, height: MARKER_SIZE, borderRadius: MARKER_SIZE / 2,
      backgroundColor: fill, borderWidth: ringed ? 1.5 : 0,
      borderColor: theme.colors.text, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
    {marker.kind === 'number' ? (progress === 'done' || progress === 'failed' || progress === 'waiting' ? props.stateGlyph
      : progress === 'running' ? <HappierSpinner size={MARKER_GLYPH_SIZE} color={theme.colors.text} />
        : progress === 'cancelled' ? <HappierStepCancelledMark color={theme.colors.mutedText} />
          : <HappierText style={{ ...numberTextStyle, color: ringed ? theme.colors.text : theme.colors.secondaryText }}>{String(marker.value)}</HappierText>)
      : marker.state === 'open' ? <View style={{ width: 8, height: 8, borderRadius: 4, borderWidth: 1.5, borderColor: theme.colors.mutedText }} />
      : marker.state === 'running' ? <HappierSpinner size={MARKER_GLYPH_SIZE} color={theme.colors[HAPPIER_TONE_COLOR_TOKEN[HAPPIER_STEP_STATE_TONE.running]]} />
        : props.stateGlyph}
  </View>;
}

/** A cancelled step's mark: a short level bar, settled and toneless (it neither passed nor failed). */
export function HappierStepCancelledMark(props: Readonly<{ color: string; width?: number }>) {
  return <View style={{ width: props.width ?? 8, height: 1.5, borderRadius: 1, backgroundColor: props.color }} />;
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
  numberState?: HappierStepProgress;
  /** A core text-host binding, preserving plain instruction versus heading semantics. */
  titleContent?: ReactNode;
  /**
   * The one operation the step asks for (a small button). It sits at the end of the step, level with
   * its words, so every step's title and detail keep one left edge; on a narrow row it moves beneath.
   */
  action?: ReactNode;
  style?: HappierStyleProp;
}>) {
  const theme = props.theme;
  const marker = props.marker;
  const markerId = props.testID === undefined ? undefined : `${props.testID}:marker`;
  const hasAction = props.action !== undefined && props.action !== null;
  const words = (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.small, minHeight: MARKER_SIZE }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          {props.titleContent ?? <HappierHeading level={3} theme={theme}>{props.title}</HappierHeading>}
        </View>
        {props.trailing === undefined || props.trailing === null ? null : (
          <View style={{ flexShrink: 1, alignItems: 'flex-end' }}>{props.trailing}</View>
        )}
      </View>
      {props.children}
    </>
  );

  return (
    <View testID={props.testID} {...(props.numberState === 'running' ? { 'aria-busy': true } : {})}
      style={[{ flexDirection: 'row', gap: theme.spacing.medium, alignItems: 'flex-start' }, props.style]}>
      <HappierStepMarkerView marker={marker} markerLabel={props.markerLabel} stateGlyph={props.stateGlyph}
        numberState={props.numberState} theme={theme} testID={markerId} />
      {hasAction ? (
        <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center',
          columnGap: theme.spacing.medium, rowGap: theme.spacing.small }}>
          <View style={{ flexGrow: 1, flexShrink: 0, flexBasis: STEP_TEXT_MIN_WIDTH_BESIDE_ACTION, minWidth: 0, maxWidth: '100%', gap: theme.spacing.small }}>
            {words}
          </View>
          <View style={{ flexShrink: 0 }}>{props.action}</View>
        </View>
      ) : (
        <View style={{ flex: 1, minWidth: 0, gap: theme.spacing.small }}>
          {words}
        </View>
      )}
    </View>
  );
}
