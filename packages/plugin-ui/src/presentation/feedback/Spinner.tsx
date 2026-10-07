import { useMemo, type ReactElement } from 'react';
import {
  ActivityIndicator as ReactNativeActivityIndicator,
  Platform,
  View,
  type ActivityIndicatorProps,
} from 'react-native';

import { useHappierUiAnimationActivityInternal, useOptionalHappierUiAccessibility, useOptionalHappierUiTheme } from '../../environment/context.js';
import type { HappierActivityIndicatorHostProps } from '../portableTypes.js';
import { HAPPIER_TONE_COLOR_TOKEN } from '../semantics.js';
import { DotSpinnerNative } from './DotSpinnerNative.js';
import { DotSpinnerWeb } from './DotSpinnerWeb.js';
import type { DotSpinnerInk } from './dotSpinnerFrames.js';
import { HAPPIER_SPINNER_SPIN_ANIMATION, useHappierSpinnerKeyframes } from './spinnerKeyframes.js';
import {
  DOT_SPINNER_STYLES,
  normalizeHappierSpinnerStyleId,
  normalizeHappierSpinnerTiming,
  type DotSpinnerStyleId,
  type HappierSpinnerPauseId,
  type HappierSpinnerSpeedId,
} from './spinnerStyles.js';

/**
 * The single implementation owner for Happier's activity spinner (UI-T27).
 *
 * The default mark is the Happier mark drawn in dots with light moving through it; the style, its
 * speed and its pause between loops are chosen by the host (Happier core reads its Settings →
 * Appearance choices; plugin surfaces draw the default wave at the default timing). The original rotating ring stays available as the `classicRing` style: on web a
 * CSS-transform ring (stepped below the small-spinner threshold), on native the platform indicator
 * with a still ring overlay on Android, whose platform widget hides when stopped.
 *
 * Paused spinners stay VISIBLE — dot styles hold the full chosen mark still and the ring stops turning —
 * because a missing spinner says the work ended. Reduced motion replaces the travelling light with a
 * gentle fade of the still chosen mark, and stops the ring.
 *
 * Host facts — colour, reduced motion, style, accents — are injected (§3.10.2). Happier core
 * supplies them from Unistyles, its app-wide preference watch and its local setting; a plugin
 * surface receives them through the projected environment.
 */
const DEFAULT_SMALL_SPINNER_SIZE = 20;
const DEFAULT_LARGE_SPINNER_SIZE = 36;
const DEFAULT_NUMERIC_SPINNER_SIZE = 20;
const STEPPED_WEB_SPINNER_MAX_SIZE = DEFAULT_SMALL_SPINNER_SIZE;
const STEPPED_WEB_SPINNER_TIMING_FUNCTION = 'steps(6, end)';
const SPINNER_ANIMATION_NAME = HAPPIER_SPINNER_SPIN_ANIMATION;

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

/** How a dot spinner moves: the style plays, the full chosen mark is held still, or (reduced motion) it breathes. */
export type HappierDotSpinnerMotion = 'animate' | 'still' | 'breathe';

export type HappierDotSpinnerModel = Readonly<{
  styleId: DotSpinnerStyleId;
  /** Playback rate of the motion. */
  speed: HappierSpinnerSpeedId;
  /** Rest between loops; styles that loop continuously ignore it. */
  pause: HappierSpinnerPauseId;
  size: number;
  motion: HappierDotSpinnerMotion;
  ink: DotSpinnerInk;
}>;

export type HappierSpinnerPresentationInput = HappierWebSpinnerPresentationInput & Readonly<{
  platform: 'web' | 'native';
  /** The host's secondary text colour, drawn when the caller gives no colour. */
  defaultColor?: string;
  /** A stored style id; an id this build does not know draws the default wave. */
  indicatorStyle?: unknown;
  /** A stored speed id; an unknown one plays at Normal. */
  indicatorSpeed?: unknown;
  /** A stored pause id; an unknown one rests for the default Short pause. */
  indicatorPause?: unknown;
  /** Theme accents for `aurora`. Without them, or with an explicit colour, aurora draws one colour. */
  auroraAccents?: readonly [string, string, string];
}>;

export type HappierSpinnerDotBoxStyle = Readonly<{
  width: number;
  height: number;
  alignSelf: 'center';
  overflow: 'hidden';
}>;

export type HappierSpinnerPresentation =
  | Readonly<{
    kind: 'dots';
    accessibilityRole: 'progressbar';
    style: HappierSpinnerDotBoxStyle;
    /** `null`: stopped and hidden on native, where the box keeps its layout slot. */
    dots: HappierDotSpinnerModel | null;
  }>
  | Readonly<{ kind: 'webRing'; accessibilityRole: 'progressbar'; style: HappierWebSpinnerStyle }>
  | Readonly<{ kind: 'nativeRing'; color: string | undefined; animating?: boolean; hidesWhenStopped?: boolean }>;

export type HappierSpinnerProps = HappierActivityIndicatorHostProps & Readonly<{
  size?: HappierActivityIndicatorHostProps['size'];
  /** Keep the spinner visible but hold it still: the full chosen mark at rest, or a ring that stops turning. */
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
      ...(animating && animationEnabled && !reducedMotion ? {
        animationDuration: '850ms',
        animationIterationCount: 'infinite',
        animationName: SPINNER_ANIMATION_NAME,
        animationTimingFunction: resolvedSize <= STEPPED_WEB_SPINNER_MAX_SIZE
          ? STEPPED_WEB_SPINNER_TIMING_FUNCTION
          : 'linear',
        willChange: 'transform',
      } : null),
      opacity: 1,
    },
  };
}

/**
 * The one spinner decision, for every host and platform: which mark to draw (dots, the web ring, or
 * the native ring), its box, its ink, and how it moves. `HappierSpinnerHost` renders the result for
 * both plugin surfaces and Happier core, preserving each caller's host props and style contract.
 */
export function resolveHappierSpinnerPresentation(
  input: HappierSpinnerPresentationInput,
): HappierSpinnerPresentation | null {
  const {
    platform,
    defaultColor,
    color,
    indicatorStyle,
    auroraAccents,
    animating = true,
    animationEnabled = true,
    hidesWhenStopped,
    reducedMotion = false,
  } = input;
  const styleId = normalizeHappierSpinnerStyleId(indicatorStyle);
  const resolvedColor = typeof color === 'string' ? color : defaultColor;

  if (styleId === 'classicRing') {
    if (platform === 'native') {
      // Only a pause (or reduced motion) forces the ring visible. A caller that stopped it itself
      // keeps its own `hidesWhenStopped`: hiding a stopped spinner is a legitimate thing to want.
      const keepVisibleWhileStill = input.animating !== false && (!animationEnabled || reducedMotion);
      return keepVisibleWhileStill
        ? { kind: 'nativeRing', color: resolvedColor, animating: false, hidesWhenStopped: false }
        : { kind: 'nativeRing', color: resolvedColor, animating: input.animating, hidesWhenStopped };
    }
    const ring = resolveHappierWebSpinnerPresentation({ ...input, color: resolvedColor });
    return ring ? { kind: 'webRing', ...ring } : null;
  }

  const hidden = !animating && hidesWhenStopped !== false;
  if (hidden && platform === 'web') return null;

  const size = resolveSpinnerSize(input.size ?? DEFAULT_NUMERIC_SPINNER_SIZE);
  const style: HappierSpinnerDotBoxStyle = { width: size, height: size, alignSelf: 'center', overflow: 'hidden' };
  if (hidden) return { kind: 'dots', accessibilityRole: 'progressbar', style, dots: null };

  const paused = !animating || !animationEnabled;
  const motion: HappierDotSpinnerMotion = paused ? 'still' : reducedMotion ? 'breathe' : 'animate';
  // Aurora uses the theme accents only when the caller left the colour to the host: an explicit
  // colour usually means a tinted surface (a filled button) where accents would not read.
  const ink: DotSpinnerInk = DOT_SPINNER_STYLES[styleId].ink === 'aurora' && color == null && auroraAccents
    ? { aurora: auroraAccents }
    : { color: resolvedColor ?? FALLBACK_DOT_INK };
  const { speed, pause } = normalizeHappierSpinnerTiming(input.indicatorSpeed, input.indicatorPause);
  return { kind: 'dots', accessibilityRole: 'progressbar', style, dots: { styleId, speed, pause, size, motion, ink } };
}

/**
 * Ink for a spinner rendered with no colour and no theme (outside any provider). Dots are drawn
 * into an image or a native view, where `currentColor` does not resolve, so they need a real colour.
 */
const FALLBACK_DOT_INK = 'gray';

/**
 * The dots of one spinner, drawn inside a host box of `model.size` that clips its overflow.
 * Use `HappierSpinnerHost` for a complete renderer. Portable primitive composition owns its clipped
 * host box and calls `useHappierSpinnerKeyframes` to install the web animation definitions.
 */
export function HappierDotSpinner(props: Readonly<{ model: HappierDotSpinnerModel }>) {
  const { styleId, speed, pause, size, motion, ink } = props.model;
  const timing = useMemo(() => ({ speed, pause }), [pause, speed]);
  // A stable ink identity per value: the native dots build their animated graph from it, and a new
  // graph on every parent render would re-attach every dot to the native driver.
  const inkColor = 'color' in ink ? ink.color : null;
  const [first, second, third] = 'aurora' in ink ? ink.aurora : [null, null, null];
  const stableInk = useMemo<DotSpinnerInk>(
    () => (inkColor !== null ? { color: inkColor } : { aurora: [first ?? '', second ?? '', third ?? ''] }),
    [first, inkColor, second, third],
  );
  if (Platform.OS === 'web') {
    return <DotSpinnerWeb styleId={styleId} timing={timing} ink={stableInk} motion={motion} />;
  }
  return <DotSpinnerNative styleId={styleId} timing={timing} size={size} ink={stableInk} motion={motion} />;
}

/**
 * The shared renderer for the spinner decision. The host carrier preserves core's complete native
 * styles and opaque colours without making the public presentation declarations depend on RN.
 * Stopped hidden spinners retain their layout host but leave accessibility traversal; motion pauses
 * remain visible and accessible. Android's native widget and still overlay stay mounted together.
 */
export function HappierSpinnerHost<HostProps extends Readonly<{
  size?: HappierActivityIndicatorHostProps['size'];
  color?: unknown;
  style?: unknown;
}>>(props: Readonly<{
  presentation: HappierSpinnerPresentation;
  hostProps: HostProps;
}>): ReactElement {
  useHappierSpinnerKeyframes();
  const { presentation } = props;
  // RN is the actual host boundary. The neutral carrier keeps its types out of public declarations.
  const {
    size,
    color,
    style,
    animating: _animating,
    hidesWhenStopped: _hidesWhenStopped,
    ...forwardedProps
  } = props.hostProps as ActivityIndicatorProps;
  const hidden = presentation.kind === 'dots'
    ? presentation.dots === null
    : presentation.kind === 'nativeRing' && presentation.animating === false && presentation.hidesWhenStopped !== false;
  const hostProps = hidden ? {
    ...forwardedProps,
    accessible: false,
    accessibilityElementsHidden: true,
    importantForAccessibility: 'no-hide-descendants' as const,
  } : forwardedProps;

  if (presentation.kind === 'nativeRing') {
    const resolvedColor = color ?? presentation.color;
    if (Platform.OS === 'android') {
      const resolvedSize = resolveSpinnerSize(size);
      const showStillRing = presentation.animating === false && !hidden;
      return (
        <View
          {...hostProps}
          accessibilityRole={hostProps.accessibilityRole ?? 'progressbar'}
          style={[{ alignItems: 'center', justifyContent: 'center' }, style]}
        >
          <ReactNativeActivityIndicator
            animating={presentation.animating !== false}
            color={resolvedColor}
            size={size}
            accessible={false}
            importantForAccessibility="no-hide-descendants"
          />
          <View
            pointerEvents="none"
            accessible={false}
            importantForAccessibility="no-hide-descendants"
            style={{
              width: resolvedSize,
              height: resolvedSize,
              alignSelf: 'center',
              borderRadius: resolvedSize / 2,
              borderWidth: resolveSpinnerBorderWidth(resolvedSize),
              borderColor: resolvedColor,
              borderTopColor: 'transparent',
              position: 'absolute',
              opacity: showStillRing ? 1 : 0,
            }}
          />
        </View>
      );
    }
    return (
      <ReactNativeActivityIndicator
        {...hostProps}
        accessibilityRole={hostProps.accessibilityRole ?? 'progressbar'}
        style={style}
        size={size}
        color={resolvedColor}
        animating={presentation.animating}
        hidesWhenStopped={presentation.hidesWhenStopped}
      />
    );
  }

  return (
    <View
      {...hostProps}
      accessibilityRole={hostProps.accessibilityRole ?? presentation.accessibilityRole}
      style={[presentation.style, style]}
    >
      {presentation.kind === 'dots' && presentation.dots ? <HappierDotSpinner model={presentation.dots} /> : null}
    </View>
  );
}

export function HappierSpinner(props: HappierSpinnerProps) {
  const theme = useOptionalHappierUiTheme();
  const environmentAccessibility = useOptionalHappierUiAccessibility();
  const presentationActive = useHappierUiAnimationActivityInternal();
  const {
    animating,
    animationEnabled,
    color,
    hidesWhenStopped,
    reducedMotion,
    size,
    style,
    ...hostProps
  } = props;

  const presentation = resolveHappierSpinnerPresentation({
    platform: Platform.OS === 'web' ? 'web' : 'native',
    defaultColor: theme?.colors[HAPPIER_TONE_COLOR_TOKEN.secondary],
    color,
    size,
    animating,
    animationEnabled: (animationEnabled ?? true) && presentationActive,
    hidesWhenStopped,
    reducedMotion: reducedMotion ?? environmentAccessibility?.reducedMotion ?? false,
  });

  if (!presentation) {
    return null;
  }
  return (
    <HappierSpinnerHost presentation={presentation} hostProps={{ ...hostProps, size, color, style }} />
  );
}
