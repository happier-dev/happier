import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type PointerEvent as WebPointerEvent,
  type ComponentType,
  type ReactNode,
} from 'react';
import { Platform, View, type PointerEvent as NativePointerEvent, type ViewStyle } from 'react-native';

import { useOptionalHappierUiTheme } from '../../environment/context.js';
import { useHappierTouchPrimaryPointer } from '../../environment/interactiveTarget.js';
import { useOptionalPluginUiPresentationHost } from '../../presentationHost/context.js';
import type { HappierPortableStyle } from '../portableTypes.js';
import {
  projectCompanionRelease,
  type CompanionReleaseMotion,
} from '../interaction/companionReleaseMotion.js';
import {
  useCompanionPointerDragSession,
  type UseCompanionPointerDragSessionParams,
} from '../interaction/useCompanionPointerDragSession.js';
import { isHappierFocusVisible } from '../interaction/focusVisible.js';
import { HAPPIER_MOTION_V1 } from '../interaction/motion.js';
import { HAPPIER_PRESENCE_CAPSULE_HEIGHT } from '../copresence/PresenceCapsule.js';
import {
  resolveFloatingFrameCorner,
  resolveFloatingFrameCornerRect,
  resolveFloatingFrameRect,
  resolveFloatingFrameResizeRect,
  resolveFloatingFrameAspectRatio,
  type FloatingFrameCorner,
  type FloatingFrameMode,
  type FrameRect,
} from './floatingFrameGeometry.js';

/**
 * The platform pointer boundary the shared companion drag session needs. The host owns listener
 * installation and coordinate reading (`useCompanionPointerDragSession`); the frame owns only what
 * a move or a resize means.
 */
export type HappierFloatingFramePointerBinding = Pick<
  UseCompanionPointerDragSessionParams<never>,
  'pointerHost' | 'readClientPoint' | 'readScreenPoint'
>;

/** `move` follows the pointer 1:1; `settle` is where a release, a key or a corner choice lands. */
export type FloatingFrameRectChange = Readonly<{ kind: 'move' | 'settle' }>;
export { resolveFloatingFrameCorner, resolveFloatingFrameCornerRect } from './floatingFrameGeometry.js';
export type { FloatingFrameCorner } from './floatingFrameGeometry.js';

/** Native libraries belong to the app. This same-realm host component binds the shared pan owner. */
export type HappierFloatingFrameNativeBindingProps = Pick<FloatingFrameProps,
  'mode' | 'rect' | 'availableRect' | 'aspectRatio' | 'minWidth' | 'moveInput'
  | 'onRectChange' | 'onModeChange' | 'reducedMotion' | 'children'> & Readonly<{
    releaseMotion: CompanionReleaseMotion;
    chromeHeight: number;
    bodyRect: FrameRect;
    /** The existing grip, carried above a retained native body by the host binding. */
    grip?: ReactNode;
}>;

export type FloatingFrameProps = Readonly<{
  mode: FloatingFrameMode;
  /** The whole frame (controls band + body) in the host's measured space. */
  rect: FrameRect;
  /** The only bound: the frame stays inside it and shrinks to fit it, over whatever is behind. */
  availableRect: FrameRect;
  /** The body's width ÷ height (the live picture's own aspect). */
  aspectRatio: number;
  /**
   * `surface`: the body moves the frame (watching). `chrome`: body pointer input belongs to the
   * content (controlling) and only the controls band and the grip move it.
   */
  moveInput: 'surface' | 'chrome';
  onRectChange: (rect: FrameRect, change: FloatingFrameRectChange) => void;
  /** The frame asks for `expanded` and `floating` (double-click, Escape); docking is the host's own control. */
  onModeChange: (mode: FloatingFrameMode) => void;
  children: ReactNode;
  /** Floating controls drawn on the host's floating material above the body. */
  controls: ReactNode;
  /**
   * Floating content below the body (who is acting, and the one control that changes it). It is part
   * of the frame: it moves with it and its height is chrome, never taken from the body's aspect.
   */
  footer?: ReactNode;
  /**
   * The narrowest usable frame, as the host measured it (its controls must fit across). Resizing
   * stops there; a viewport narrower than it still shrinks the frame to fit.
   */
  minWidth?: number;
  accessibilityLabel: string;
  /** Accessible names for the grip; the host supplies its translated `presentation.*` labels. */
  resizeLabel?: string;
  /** Platform pointer binding; absent, the presentation host's binding is used, then keyboard only. */
  pointer?: HappierFloatingFramePointerBinding;
  /** Stable host component; defaults to the presentation host's native frame binding. */
  nativeBinding?: ComponentType<HappierFloatingFrameNativeBindingProps>;
  /** How a thrown frame comes to rest (the shared companion release parameterization). */
  releaseMotion?: CompanionReleaseMotion;
  reducedMotion?: boolean;
  /** Touch devices keep the controls visible; pointer devices reveal them on hover and focus. */
  controlsAlwaysVisible?: boolean;
  colors?: Readonly<{ grip?: string; focusRing?: string }>;
  testID?: string;
}>;

/** The controls band above the body and its gap; the body is the rest of the frame. */
export const HAPPIER_FLOATING_FRAME_METRICS = Object.freeze({
  controlsHeight: 32,
  gap: 8,
  /** The footer holds one presence capsule, so it is that capsule's height. */
  footerHeight: HAPPIER_PRESENCE_CAPSULE_HEIGHT,
  bodyRadius: 12,
  gripSize: 16,
  /** One resize step (the grip's arrow keys, a host's Larger/Smaller), as a share of the width. */
  resizeStep: 0.1,
});

/** Which optional bands a frame draws around its body. */
export type FloatingFrameChromeOptions = Readonly<{ footer?: boolean }>;

/** The frame's fixed vertical space around the body: controls band, gaps and the footer. */
export function resolveFloatingFrameChromeHeight(
  options?: FloatingFrameChromeOptions,
): number {
  const { controlsHeight, gap, footerHeight } = HAPPIER_FLOATING_FRAME_METRICS;
  return controlsHeight + gap + (options?.footer ? gap + footerHeight : 0);
}


/**
 * The frame reads a release motion's duration (how long it travels) and its projection (which
 * corner a throw aims at). It always settles critically damped, so the damping and velocity fields
 * of the shared companion type carry their neutral values here.
 */
const DEFAULT_RELEASE_MOTION: CompanionReleaseMotion = Object.freeze({
  durationMs: HAPPIER_MOTION_V1.slowMs,
  dampingRatio: 1,
  overshootClamping: false,
  carryVelocity: false,
  projectionSeconds: 0,
});

/** `ω·T` at which a critically damped spring is within a thousandth of rest. */
const SETTLE_SPRING_REST = 9.2;
const SETTLE_SPRING_SAMPLES = 16;

/** A critically damped spring's position over its duration, as a CSS `linear()` easing. */
const SETTLE_SPRING_EASING_CSS = `linear(${Array.from(
  { length: SETTLE_SPRING_SAMPLES + 1 },
  (_, index) => {
    if (index === SETTLE_SPRING_SAMPLES) return '1';
    const phase = (index / SETTLE_SPRING_SAMPLES) * SETTLE_SPRING_REST;
    return (1 - (1 + phase) * Math.exp(-phase)).toFixed(4).replace(/\.?0+$/, '') || '0';
  },
).join(', ')})`;

/** On web a frame travels by transform (the compositor); only a size change lays it out again. */
const FLOATING_FRAME_SETTLE_PROPERTIES = 'transform, width, height';

/**
 * Where a floating frame stands inside its container. On web its place is a transform so the settle
 * travels on the compositor; native places it by its own binding.
 */
export function resolveFloatingFramePlacementStyle(rect: FrameRect): HappierPortableStyle {
  return Platform.OS === 'web'
    ? {
        position: 'absolute',
        left: 0,
        top: 0,
        width: rect.width,
        height: rect.height,
        transform: [{ translateX: rect.x }, { translateY: rect.y }],
      }
    : {
        position: 'absolute',
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
      };
}

/**
 * How a released frame travels to where it settles: one critically damped spring curve (it arrives
 * without overshoot or wobble), on `properties` (`transform` for its place, then its size). A host that
 * draws the frame's body in another layer places it with `resolveFloatingFramePlacementStyle` and
 * applies this same transition, so the two cannot drift apart.
 */
export function resolveFloatingFrameSettleTransition(
  motion: Pick<CompanionReleaseMotion, 'durationMs'> = DEFAULT_RELEASE_MOTION,
): Readonly<{ durationMs: number; easingCss: string; properties: string }> {
  return {
    durationMs: motion.durationMs,
    easingCss: SETTLE_SPRING_EASING_CSS,
    properties: FLOATING_FRAME_SETTLE_PROPERTIES,
  };
}

const NO_DRAG_SELECTOR =
  '[data-happier-floating-frame-no-drag="true"], [role="button"], [role="tab"], button, a, input, textarea';
const HANDLE_SELECTOR = '[data-happier-floating-frame-handle="true"]';
const GRIP_SELECTOR = '[data-happier-floating-frame-grip="true"]';

type WebTransitionStyle = ViewStyle & {
  transitionProperty?: string;
  transitionDuration?: string;
  transitionTimingFunction?: string;
};

/** The body's place inside a frame rect. */
export function resolveFloatingFrameBodyRect(
  rect: FrameRect,
  options?: FloatingFrameChromeOptions,
): FrameRect {
  const top =
    HAPPIER_FLOATING_FRAME_METRICS.controlsHeight +
    HAPPIER_FLOATING_FRAME_METRICS.gap;
  return {
    x: rect.x,
    y: rect.y + top,
    width: rect.width,
    height: Math.max(0, rect.height - resolveFloatingFrameChromeHeight(options)),
  };
}

/** A frame of `width` whose body keeps `aspectRatio`. */
export function resolveFloatingFrameHeight(
  width: number,
  aspectRatio: number,
  options?: FloatingFrameChromeOptions,
): number {
  const aspect = resolveFloatingFrameAspectRatio(aspectRatio);
  return resolveFloatingFrameChromeHeight(options) + width / aspect;
}

function clampRect(rect: FrameRect, available: FrameRect): FrameRect {
  const width = Math.min(rect.width, available.width);
  const height = Math.min(rect.height, available.height);
  return {
    x: Math.min(
      available.x + available.width - width,
      Math.max(available.x, rect.x),
    ),
    y: Math.min(
      available.y + available.height - height,
      Math.max(available.y, rect.y),
    ),
    width,
    height,
  };
}

/** The grip must stay inside the body; the host's measured minimum is the usable one. */
function resolveMinimumWidth(props: Pick<FloatingFrameProps, 'minWidth'>): number {
  return Math.max(HAPPIER_FLOATING_FRAME_METRICS.gripSize * 2, props.minWidth ?? 0);
}

function readKey(event: unknown): string | null {
  const record = event as {
    key?: unknown;
    nativeEvent?: { key?: unknown };
  } | null;
  const key = record?.nativeEvent?.key ?? record?.key;
  return typeof key === 'string' ? key : null;
}

function consume(event: unknown): void {
  const record = event as {
    preventDefault?: () => void;
    stopPropagation?: () => void;
  } | null;
  record?.preventDefault?.();
  record?.stopPropagation?.();
}

/**
 * The one neutral floating frame: a controlled rect, a controls band, one retained body. It never
 * knows what the body shows (no target, Session, network or trust facts) and never grants control:
 * the host feeds `moveInput`. Drag, velocity and release come from the shared companion interaction
 * owner; settling clamps to `availableRect` through `resolveFloatingFrameRect` and nothing else, so
 * the frame floats over whatever is behind it. `closed` renders nothing; `docked` draws the same
 * body in flow.
 */
export function FloatingFrame(props: FloatingFrameProps) {
  const presentationHost = useOptionalPluginUiPresentationHost();
  const pointer = props.pointer ?? presentationHost?.companionPointer;
  const NativeBinding = Platform.OS === 'web' ? undefined : props.nativeBinding ?? presentationHost?.companionNativeFrame;
  const motion = props.releaseMotion ?? DEFAULT_RELEASE_MOTION;
  const [interacting, setInteracting] = useState(false);
  const [hovered, setHovered] = useState(false);
  // A finger never hovers: once one reaches the frame, or when the primary pointer cannot hover at
  // all, the controls stay shown instead of waiting for a reveal that cannot come.
  const touchPrimaryPointer = useHappierTouchPrimaryPointer(Platform.OS);
  const [touchPointer, setTouchPointer] = useState(false);
  const environmentTheme = useOptionalHappierUiTheme();
  const [focused, setFocused] = useState(false);
  // The body's ring marks keyboard focus on the frame itself (arrow keys move it). A focused control
  // inside draws its own ring, and a pointer press never leaves one (focusVisible.ts).
  const [frameFocusVisible, setFrameFocusVisible] = useState(false);
  const [bodyNode, setBodyNode] = useState<View | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const gestureRef = useRef<{
    start: FrameRect;
    current: FrameRect;
    velocityX: number;
    velocityY: number;
  } | null>(null);

  const floating = props.mode === 'floating';
  const dragEnabled = floating && pointer != null;

  const settleAt = useCallback(
    (rect: FrameRect, corner?: FloatingFrameCorner, projectedPoint?: Readonly<{ x: number; y: number }>) => {
      const current = latest.current;
      const target = corner
        ? resolveFloatingFrameCornerRect(corner, rect, current.availableRect)
        : rect;
      const placement = resolveFloatingFrameRect({
        rect: target,
        availableRect: current.availableRect,
        aspectRatio: current.aspectRatio,
        chromeHeight: resolveFloatingFrameChromeHeight({ footer: current.footer != null }),
        minWidth: current.minWidth,
        projectedPoint,
      });
      if (placement.fits) current.onRectChange(placement.rect, { kind: 'settle' });
    },
    [],
  );

  const begin = useCallback(() => {
    const rect = latest.current.rect;
    gestureRef.current = {
      start: rect,
      current: rect,
      velocityX: 0,
      velocityY: 0,
    };
    setInteracting(true);
  }, []);

  const moveSession = useCompanionPointerDragSession({
    enabled: dragEnabled,
    coordinateSpace: 'client',
    selectors: {
      noDrag: `${NO_DRAG_SELECTOR}, ${GRIP_SELECTOR}`,
      handle: HANDLE_SELECTOR,
    },
    onDragStart: begin,
    onDragMove: (move) => {
      const gesture = gestureRef.current;
      if (!gesture) return;
      gesture.current = clampRect(
        {
          ...gesture.start,
          x: gesture.start.x + move.totalDeltaX,
          y: gesture.start.y + move.totalDeltaY,
        },
        latest.current.availableRect,
      );
      latest.current.onRectChange(gesture.current, { kind: 'move' });
    },
    onDragRelease: (release) => {
      if (!gestureRef.current) return;
      gestureRef.current.velocityX = release.velocityX;
      gestureRef.current.velocityY = release.velocityY;
    },
    onDragEnd: (end) => {
      const gesture = gestureRef.current;
      gestureRef.current = null;
      setInteracting(false);
      if (!gesture) return;
      // A cancelled pointer settles where the frame is; it never carries the throw.
      const velocityX = end.cancelled ? 0 : gesture.velocityX;
      const velocityY = end.cancelled ? 0 : gesture.velocityY;
      const rect = gesture.current;
      const projected = {
        x: projectCompanionRelease(rect.x, velocityX, motion),
        y: projectCompanionRelease(rect.y, velocityY, motion),
      };
      settleAt(
        rect,
        undefined,
        projected,
      );
    },
    readClientPoint: pointer?.readClientPoint ?? (() => ({ x: null, y: null })),
    readScreenPoint: pointer?.readScreenPoint ?? (() => ({ x: null, y: null })),
    pointerHost: pointer?.pointerHost ?? NOOP_POINTER_HOST,
  });

  const resizeSession = useCompanionPointerDragSession({
    enabled: dragEnabled,
    coordinateSpace: 'client',
    selectors: {
      noDrag: '[data-happier-floating-frame-no-drag="true"]',
      handle: GRIP_SELECTOR,
    },
    onDragStart: begin,
    onDragMove: (move) => {
      const gesture = gestureRef.current;
      if (!gesture) return;
      // The grip sits at the body's leading-bottom corner; the trailing-top corner stays put.
      const current = latest.current;
      gesture.current = resolveFloatingFrameResizeRect({
        rect: gesture.start, availableRect: current.availableRect,
        translationX: move.totalDeltaX, aspectRatio: current.aspectRatio,
        chromeHeight: resolveFloatingFrameChromeHeight({ footer: current.footer != null }),
        minWidth: resolveMinimumWidth(current),
      });
      current.onRectChange(gesture.current, { kind: 'move' });
    },
    onDragEnd: () => {
      const gesture = gestureRef.current;
      gestureRef.current = null;
      setInteracting(false);
      if (gesture) settleAt(gesture.current);
    },
    readClientPoint: pointer?.readClientPoint ?? (() => ({ x: null, y: null })),
    readScreenPoint: pointer?.readScreenPoint ?? (() => ({ x: null, y: null })),
    pointerHost: pointer?.pointerHost ?? NOOP_POINTER_HOST,
  });

  const onKeyDown = useCallback(
    (event: unknown) => {
      const current = latest.current;
      const key = readKey(event);
      if (current.mode === 'expanded' && key === 'Escape') {
        consume(event);
        current.onModeChange('floating');
        return;
      }
      if (current.mode !== 'floating') return;
      const rect = current.rect;
      const corner = resolveFloatingFrameCorner(
        { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
        current.availableRect,
      );
      const left = corner === 'tl' || corner === 'bl';
      const top = corner === 'tl' || corner === 'tr';
      const next: Record<string, FloatingFrameCorner> = {
        ArrowLeft: top ? 'tl' : 'bl',
        ArrowRight: top ? 'tr' : 'br',
        ArrowUp: left ? 'tl' : 'tr',
        ArrowDown: left ? 'bl' : 'br',
      };
      const target = key ? next[key] : undefined;
      if (!target) return;
      consume(event);
      settleAt(rect, target);
    },
    [settleAt],
  );

  const onGripKeyDown = useCallback(
    (event: unknown) => {
      const current = latest.current;
      if (current.mode !== 'floating') return;
      const key = readKey(event);
      const grow = key === 'ArrowLeft' || key === 'ArrowUp';
      const shrink = key === 'ArrowRight' || key === 'ArrowDown';
      if (!grow && !shrink) return;
      consume(event);
      const rect = current.rect;
      const width = Math.min(
        current.availableRect.width,
        Math.max(
          resolveMinimumWidth(current),
          rect.width *
            (grow
              ? 1 + HAPPIER_FLOATING_FRAME_METRICS.resizeStep
              : 1 - HAPPIER_FLOATING_FRAME_METRICS.resizeStep),
        ),
      );
      const right = rect.x + rect.width;
      settleAt(
        clampRect(
          {
            x: right - width,
            y: rect.y,
            width,
            height: resolveFloatingFrameHeight(width, current.aspectRatio, {
              footer: current.footer != null,
            }),
          },
          current.availableRect,
        ),
      );
    },
    [settleAt],
  );

  // A double-click on the watched picture expands it, and restores it when expanded (web pointer).
  useEffect(() => {
    const node = bodyNode as unknown as HTMLElement | null;
    if (Platform.OS !== 'web' || typeof node?.addEventListener !== 'function') return undefined;
    const onDoubleClick = (event: MouseEvent) => {
      const current = latest.current;
      if (current.moveInput !== 'surface') return;
      const target = event.target as Element | null;
      if (target?.closest?.(`${NO_DRAG_SELECTOR}, ${GRIP_SELECTOR}`)) return;
      if (current.mode === 'floating') current.onModeChange('expanded');
      else if (current.mode === 'expanded') current.onModeChange('floating');
    };
    node.addEventListener('dblclick', onDoubleClick);
    return () => node.removeEventListener('dblclick', onDoubleClick);
  }, [bodyNode]);

  if (props.mode === 'closed') return null;

  const controlsShown =
    props.controlsAlwaysVisible === true ||
    touchPrimaryPointer ||
    touchPointer ||
    !floating ||
    hovered ||
    focused ||
    interacting;
  const settle = resolveFloatingFrameSettleTransition(motion);
  const transition: WebTransitionStyle | null =
    Platform.OS === 'web' &&
    props.mode !== 'docked' &&
    !interacting &&
    props.reducedMotion !== true
      ? {
          transitionProperty: FLOATING_FRAME_SETTLE_PROPERTIES,
          transitionDuration: `${settle.durationMs}ms`,
          transitionTimingFunction: settle.easingCss,
        }
      : null;
  const controlsTransition: WebTransitionStyle | null =
    Platform.OS === 'web' && props.reducedMotion !== true
      ? {
          transitionProperty: 'opacity',
          transitionDuration: `${HAPPIER_MOTION_V1.fastMs}ms`,
          transitionTimingFunction: HAPPIER_MOTION_V1.standardEasingCss,
        }
      : null;
  const frameStyle =
    props.mode === 'docked'
      ? { width: '100%' as const }
      : resolveFloatingFramePlacementStyle(
          props.mode === 'expanded' ? props.availableRect : props.rect,
        );
  const bodyStyle =
    props.mode === 'docked'
      ? {
          width: '100%' as const,
          aspectRatio: props.aspectRatio > 0 ? props.aspectRatio : undefined,
        }
      : { flex: 1, minHeight: 0 };
  const webOnly = (value: Record<string, string>) =>
    Platform.OS === 'web' ? { dataSet: value } : {};
  const frameEventHandlers = {
    onKeyDown,
    onFocus: (event: { target: unknown; currentTarget: unknown }) => {
      setFocused(true);
      setFrameFocusVisible(event.target === event.currentTarget && isHappierFocusVisible(event.target));
    },
    onBlur: () => {
      setFocused(false);
      setFrameFocusVisible(false);
    },
    onPointerEnter: (event: WebPointerEvent<HTMLElement> | NativePointerEvent) => {
      if ('pointerType' in event && event.pointerType === 'touch') setTouchPointer(true);
      setHovered(true);
    },
    onPointerLeave: () => setHovered(false),
  } satisfies Pick<
    HTMLAttributes<HTMLElement>,
    'onKeyDown' | 'onFocus' | 'onBlur' | 'onPointerEnter' | 'onPointerLeave'
  >;
  const gripEventHandlers = {
    onKeyDown: onGripKeyDown,
  } satisfies Pick<HTMLAttributes<HTMLElement>, 'onKeyDown'>;

  const grip = floating ? (
    <View
      ref={resizeSession.dragTargetRef}
      testID={props.testID ? `${props.testID}-grip` : undefined}
      accessibilityLabel={props.resizeLabel}
      role="button"
      focusable
      {...gripEventHandlers}
      style={[
        {
          position: 'absolute', left: 0, bottom: 0,
          width: HAPPIER_FLOATING_FRAME_METRICS.gripSize * 2,
          height: HAPPIER_FLOATING_FRAME_METRICS.gripSize * 2,
          opacity: controlsShown ? 1 : 0,
        },
        Platform.OS === 'web' ? ({ cursor: 'nesw-resize' } as object) : null,
        controlsTransition,
      ]}
      {...webOnly({ happierFloatingFrameGrip: 'true' })}
      {...resizeSession.pointerHandlers}
    >
      <View pointerEvents="none" style={{
        position: 'absolute', left: 8, bottom: 8, width: 8, height: 8,
        borderLeftWidth: 2, borderBottomWidth: 2, borderBottomLeftRadius: 3,
        borderColor: props.colors?.grip ?? environmentTheme?.colors.mutedText,
      }} />
    </View>
  ) : null;
  const frame = (
    <View
      ref={moveSession.dragTargetRef}
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel}
      // On the web a frame's host presents it above the router, outside the page's main landmark: the
      // frame is its own named region. Native keeps the group (it has no landmark navigation).
      role={Platform.OS === 'web' ? 'region' : 'group'}
      focusable={floating}
      {...webOnly({ happierFloatingFrame: 'true' })}
      {...frameEventHandlers}
      style={[
        frameStyle,
        NativeBinding && props.mode !== 'docked' ? { position: 'relative', left: 0, top: 0, width: '100%', height: '100%' } : null,
        { flexDirection: 'column', gap: HAPPIER_FLOATING_FRAME_METRICS.gap },
        transition,
      ]}
      {...moveSession.pointerHandlers}
    >
      <View
        testID={props.testID ? `${props.testID}-controls` : undefined}
        style={[
          {
            height: HAPPIER_FLOATING_FRAME_METRICS.controlsHeight,
            flexDirection: 'row',
            alignItems: 'center',
          },
          { opacity: controlsShown ? 1 : 0 },
          controlsTransition,
        ]}
        {...webOnly({ happierFloatingFrameHandle: String(dragEnabled) })}
      >
        {props.controls}
      </View>
      <View
        ref={setBodyNode}
        testID={props.testID ? `${props.testID}-body` : undefined}
        style={[
          bodyStyle,
          {
            borderRadius: HAPPIER_FLOATING_FRAME_METRICS.bodyRadius,
            overflow: 'hidden',
          },
          frameFocusVisible && props.colors?.focusRing
            ? ({
                outlineWidth: 2,
                outlineStyle: 'solid',
                outlineColor: props.colors.focusRing,
              } as object)
            : null,
        ]}
        {...webOnly({
          happierFloatingFrameHandle: String(
            dragEnabled && props.moveInput === 'surface',
          ),
        })}
      >
        {props.children}
        {NativeBinding ? null : grip}
      </View>
      {props.footer != null ? (
        <View
          testID={props.testID ? `${props.testID}-footer` : undefined}
          style={{
            height: HAPPIER_FLOATING_FRAME_METRICS.footerHeight,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          {...webOnly({ happierFloatingFrameHandle: String(dragEnabled) })}
        >
          {/* Content wider than the frame (a long machine name) shrinks inside it instead of spilling past both edges. */}
          <View style={{ maxWidth: '100%', minWidth: 0, flexShrink: 1 }}>{props.footer}</View>
        </View>
      ) : null}
    </View>
  );
  return NativeBinding ? (
    <NativeBinding
      mode={props.mode} rect={props.mode === 'expanded' ? props.availableRect : props.rect}
      availableRect={props.availableRect}
      aspectRatio={props.aspectRatio} minWidth={props.minWidth} moveInput={props.moveInput}
      onRectChange={props.onRectChange} onModeChange={props.onModeChange}
      reducedMotion={props.reducedMotion} releaseMotion={motion}
      chromeHeight={resolveFloatingFrameChromeHeight({ footer: props.footer != null })}
      bodyRect={resolveFloatingFrameBodyRect(props.mode === 'expanded' ? props.availableRect : props.rect, { footer: props.footer != null })}
      grip={grip}
    >{frame}</NativeBinding>
  ) : frame;
}

const NOOP_POINTER_HOST: HappierFloatingFramePointerBinding['pointerHost'] = {
  capturePointer: () => {},
  releasePointer: () => {},
  listenForStart: () => () => {},
  listenForActive: () => () => {},
};
