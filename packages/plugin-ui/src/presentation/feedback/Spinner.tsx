import {
  ActivityIndicator as ReactNativeActivityIndicator,
  Platform,
  View,
} from 'react-native';

import { useOptionalHappierUiAccessibility, useOptionalHappierUiTheme } from '../../environment/context.js';
import type { HappierActivityIndicatorHostProps } from '../portableTypes.js';
import { HAPPIER_TONE_COLOR_TOKEN } from '../semantics.js';

/**
 * The single implementation owner for Happier's activity spinner (UI-T27).
 *
 * Extracted from `apps/ui/sources/components/ui/feedback/ActivitySpinner.tsx`,
 * whose measured behaviour it preserves exactly: React Native Web's own
 * `ActivityIndicator` is replaced on web by a CSS-transform ring, the stepped
 * timing function is used below the small-spinner threshold, and a
 * reduced-motion preference keeps the ring VISIBLE while removing its
 * animation rather than hiding the fact that work is in progress.
 *
 * The two host facts it needs — the resolved colour and the reduced-motion
 * preference — are injected (§3.10.2). Happier core supplies them from
 * Unistyles and its app-wide preference watch; a plugin surface receives them
 * through the projected environment.
 */
const DEFAULT_SMALL_SPINNER_SIZE = 20;
const DEFAULT_LARGE_SPINNER_SIZE = 36;
const DEFAULT_NUMERIC_SPINNER_SIZE = 20;
const STEPPED_WEB_SPINNER_MAX_SIZE = DEFAULT_SMALL_SPINNER_SIZE;
const STEPPED_WEB_SPINNER_TIMING_FUNCTION = 'steps(6, end)';
const SPINNER_ANIMATION_NAME = 'happierActivitySpinnerSpin';

export type HappierWebSpinnerStyle = Readonly<{
  alignSelf: 'center';
  animationDuration?: string;
  animationIterationCount?: 'infinite';
  animationName?: string;
  animationTimingFunction?: string;
  borderColor: string;
  borderRadius: number;
  borderTopColor: 'transparent';
  borderWidth: number;
  height: number;
  opacity: number;
  width: number;
  willChange?: string;
}>;

export type HappierWebSpinnerPresentationInput = Readonly<{
  animating?: boolean;
  animationEnabled?: boolean;
  /** Runtime colour values are normalized to CSS only when they are strings. */
  color?: unknown;
  hidesWhenStopped?: boolean;
  reducedMotion?: boolean;
  size?: HappierActivityIndicatorHostProps['size'];
}>;

export type HappierWebSpinnerPresentation = Readonly<{
  accessibilityRole: 'progressbar';
  style: HappierWebSpinnerStyle;
}>;

export type HappierSpinnerProps = HappierActivityIndicatorHostProps & Readonly<{
  size?: HappierActivityIndicatorHostProps['size'];
  /** Keep the web spinner visible while disabling the CSS transform animation. */
  animationEnabled?: boolean;
  /**
   * The resolved reduced-motion preference.
   *
   * Injected rather than reached for: Happier core owns one app-wide watch
   * (`useReducedMotionPreference`) it does not want a hundred list rows to
   * subscribe to individually, and a plugin surface receives the fact in its
   * projected context. When omitted the environment value is used.
   */
  reducedMotion?: boolean;
}>;

/**
 * A vector icon draws its circle INSET in its em box, but a spinner's diameter IS its box. So a
 * spinner and an Ionicons `checkmark-circle` given the same number render at visibly different
 * sizes, and a status slot that swaps one for the other appears to change size as it settles.
 *
 * Measured from a rendered transcript at matched scale: a filled circle glyph declared at 16 draws
 * ~12.8px of ink, next to a `size="small"` spinner's full 20px ring — the running state read 1.55x
 * the size of the success state it turns into.
 *
 * Every status slot that pairs a spinner with a glyph derives the spinner from the glyph size here.
 * Before this existed, four of them each guessed separately and all four disagreed.
 */
const ICON_CIRCLE_INK_RATIO = 0.8;

export function iconMatchedSpinnerSize(iconSize: number): number {
  return Math.round(iconSize * ICON_CIRCLE_INK_RATIO);
}

function resolveSpinnerSize(size: HappierActivityIndicatorHostProps['size']): number {
  if (typeof size === 'number' && Number.isFinite(size)) {
    return Math.max(1, size);
  }
  if (size === 'large') {
    return DEFAULT_LARGE_SPINNER_SIZE;
  }
  return DEFAULT_SMALL_SPINNER_SIZE;
}

function resolveSpinnerBorderWidth(size: number): number {
  return Math.max(1.5, Math.min(3, size / 8));
}

/**
 * The shared web spinner decision: visibility, size, motion and CSS ring
 * metrics. It deliberately returns a bounded spinner model, not a generic
 * host-style bridge, so the portable primitive and core's private RN adapter
 * use one policy while retaining their own valid style contracts.
 */
export function resolveHappierWebSpinnerPresentation(
  input: HappierWebSpinnerPresentationInput,
): HappierWebSpinnerPresentation | null {
  const {
    animating = true,
    animationEnabled = true,
    color,
    hidesWhenStopped = true,
    reducedMotion = false,
    size,
  } = input;

  if (!animating && hidesWhenStopped) {
    return null;
  }

  const resolvedSize = resolveSpinnerSize(size ?? DEFAULT_NUMERIC_SPINNER_SIZE);
  return {
    accessibilityRole: 'progressbar',
    style: {
      width: resolvedSize,
      height: resolvedSize,
      alignSelf: 'center',
      borderRadius: resolvedSize / 2,
      borderWidth: resolveSpinnerBorderWidth(resolvedSize),
      borderColor: typeof color === 'string' ? color : 'currentColor',
      borderTopColor: 'transparent',
      ...(animationEnabled && !reducedMotion ? {
        animationDuration: '850ms',
        animationIterationCount: 'infinite',
        animationName: SPINNER_ANIMATION_NAME,
        animationTimingFunction: resolvedSize <= STEPPED_WEB_SPINNER_MAX_SIZE
          ? STEPPED_WEB_SPINNER_TIMING_FUNCTION
          : 'linear',
        willChange: 'transform',
      } : null),
      opacity: animating ? 1 : 0,
    },
  };
}

export function HappierSpinner(props: HappierSpinnerProps) {
  const theme = useOptionalHappierUiTheme();
  const environmentAccessibility = useOptionalHappierUiAccessibility();
  const resolvedColor = props.color ?? theme?.colors[HAPPIER_TONE_COLOR_TOKEN.secondary];
  const reducedMotion = props.reducedMotion ?? environmentAccessibility?.reducedMotion ?? false;

  if (Platform.OS !== 'web') {
    const {
      animationEnabled,
      reducedMotion: _reducedMotion,
      animating,
      hidesWhenStopped,
      size,
      ...native
    } = props;
    const keepIndeterminateSpinnerVisible = animating !== false && (
      animationEnabled === false || reducedMotion
    );
    return (
      <ReactNativeActivityIndicator
        {...native}
        size={size}
        color={resolvedColor}
        animating={keepIndeterminateSpinnerVisible ? false : animating}
        hidesWhenStopped={keepIndeterminateSpinnerVisible ? false : hidesWhenStopped}
      />
    );
  }

  return <WebSpinner {...props} resolvedColor={resolvedColor} resolvedReducedMotion={reducedMotion} />;
}

function WebSpinner(props: HappierSpinnerProps & Readonly<{
  resolvedColor: string | undefined;
  resolvedReducedMotion: boolean;
}>) {
  const {
    animating,
    animationEnabled,
    color: _color,
    hidesWhenStopped,
    reducedMotion,
    size,
    style,
    resolvedColor,
    ...viewProps
  } = props;

  const presentation = resolveHappierWebSpinnerPresentation({
    animating,
    animationEnabled,
    color: resolvedColor,
    hidesWhenStopped,
    reducedMotion: reducedMotion ?? props.resolvedReducedMotion,
    size,
  });

  if (!presentation) {
    return null;
  }

  return (
    <View
      {...viewProps}
      accessibilityRole={props.accessibilityRole ?? presentation.accessibilityRole}
      style={[presentation.style, style]}
    />
  );
}
