import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';

import type { HappierStyleProp } from '../portableTypes.js';
import type { HappierSurfaceGlyphRenderer } from '../status/capsuleHost.js';

/** Where the agent is acting, normalized to the page (0..1). A point, or a point with its element. */
export type HappierAgentTarget = Readonly<{ x: number; y: number; width?: number; height?: number }>;

/**
 * One pointer action of the agent. The host keeps the latest one until the next action replaces it, so a
 * short action that began and ended between two renders still reaches the cursor. `id` names the action
 * (the host's own request id); the cursor presents each id once.
 */
export type HappierAgentPoint = Readonly<{ id: string; target: HappierAgentTarget }>;

/** Where the page is drawn inside the cursor's layer (px), when it does not fill it (a fitted stream). */
export type HappierAgentPageRect = Readonly<{ x: number; y: number; width: number; height: number }>;

/** The positions the cursor moves: the hand's point and the ring's box. */
export type HappierAgentCursorChannel = 'x' | 'y' | 'ringLeft' | 'ringTop' | 'ringWidth' | 'ringHeight';

/**
 * The cursor's motion seam. The cursor decides WHAT moves and when (travel or appear in place, the ring
 * growing out of the hand, fades in and out); the host decides how it animates, on its own travel spring
 * and fade duration. Happier core drives it with Reanimated from its motion tokens; plugin-ui carries
 * no animation library.
 */
export type HappierAgentCursorMotion = Readonly<{
  /** Place a channel at once. */
  set: (channel: HappierAgentCursorChannel, value: number) => void;
  /** Travel a channel on the host's critically damped travel spring; a later call redirects it mid-way. */
  travel: (channel: HappierAgentCursorChannel, value: number) => void;
  setOpacity: (layer: 'pointer' | 'ring', value: number) => void;
  /**
   * Fade a layer on the host's fast duration: `standard` to arrive or settle, `exit` to leave.
   * `onDone` runs once the fade has run to its end; a later call that redirects the layer cancels it.
   */
  fade: (layer: 'pointer' | 'ring', to: number, curve: 'standard' | 'exit', onDone?: () => void) => void;
  /** The ring's current opacity, so a ring that was not drawn for the last target grows from the hand. */
  ringOpacity: () => number;
}>;

export type HappierAgentCursorLayerProps<Motion extends HappierAgentCursorMotion> = Readonly<{
  motion: Motion;
  style: HappierStyleProp;
  testID: string;
  children?: ReactNode;
}>;

export type HappierAgentCursorMotionDriver<Motion extends HappierAgentCursorMotion = HappierAgentCursorMotion> = Readonly<{
  useMotion: () => Motion;
  /** The hand: paints the pointer's opacity and its `x`/`y` translation. */
  Pointer: ComponentType<HappierAgentCursorLayerProps<Motion>>;
  /** The ring: paints its opacity and its `ringLeft`/`ringTop`/`ringWidth`/`ringHeight` box. */
  Ring: ComponentType<HappierAgentCursorLayerProps<Motion>>;
}>;

export type HappierAgentCursorColors = Readonly<{
  /** The hand, the mark plate's edge and the ring line (Happier: primary text, as agent marks are drawn). */
  line: string;
  /** The mark plate and the ring's casing (Happier: the base surface). */
  casing: string;
}>;

export type HappierAgentCursorProps<Motion extends HappierAgentCursorMotion = HappierAgentCursorMotion> = Readonly<{
  /** Where the agent is acting now (normalized to the page); `null` when it is not acting. */
  target: HappierAgentTarget | null;
  /**
   * The agent's latest pointer action, kept by the host until the next one replaces it. A new `id` is
   * always shown: the hand and ring arrive, hold while `target` is still live, then leave, even when the
   * action began and ended between two renders. A point that is already present when the cursor mounts is
   * not replayed. Omitted, the cursor follows `target` alone and a target that comes and goes within one
   * render is never seen. Reduced motion: it appears at once and stays until the host withdraws the point.
   */
  point?: HappierAgentPoint | null;
  /**
   * The drawn page inside this layer. The target is normalized to the page, so a letterboxed stream
   * (fitted with `contain`) maps into this rect; omitted, the page fills the layer.
   */
  pageRect?: HappierAgentPageRect | null;
  /** The agent's mark on the hand, at the given size; omitted, the plate stays empty. */
  renderAgentMark?: (size: number) => ReactNode;
  renderGlyph: HappierSurfaceGlyphRenderer;
  colors: HappierAgentCursorColors;
  reducedMotion: boolean;
  motion: HappierAgentCursorMotionDriver<Motion>;
  testID: string;
}>;

const CURSOR_SIZE = 22;
const MARK_SIZE = 18;
const MARK_GLYPH_SIZE = 11;
const RING_OUTSET = 3;

const styles = StyleSheet.create({
  layer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 3,
  },
  cursor: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: CURSOR_SIZE + MARK_SIZE,
    height: CURSOR_SIZE + MARK_SIZE,
  },
  mark: {
    position: 'absolute',
    left: CURSOR_SIZE - 6,
    top: CURSOR_SIZE - 6,
    width: MARK_SIZE,
    height: MARK_SIZE,
    borderRadius: MARK_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
  },
  ring: {
    position: 'absolute',
    borderRadius: 10,
    borderWidth: 2,
  },
  ringCasing: {
    ...StyleSheet.absoluteFillObject,
    margin: -3,
    borderRadius: 12,
    borderWidth: 1,
  },
});

type Box = Readonly<{ left: number; top: number; width: number; height: number }>;

/**
 * Where the hand and the ring sit inside the layer for a page-normalized target: the point maps into the
 * drawn page, and the ring sits a few pixels outside the element so it never covers its edge.
 */
const clampUnit = (value: number) => Math.max(0, Math.min(1, value));

export function resolveHappierAgentCursorPlacement(
  target: HappierAgentTarget | null,
  page: HappierAgentPageRect | null,
): Readonly<{ point: Readonly<{ x: number; y: number }> | null; ring: Box | null }> {
  if (!target || !page) return { point: null, ring: null };
  // The hand stays on the drawn page: a point reported past its edge (the page changed size since) rests on the edge.
  const point = { x: page.x + clampUnit(target.x) * page.width, y: page.y + clampUnit(target.y) * page.height };
  const ring = typeof target.width === 'number' && typeof target.height === 'number'
    ? {
      left: page.x + (target.x - target.width / 2) * page.width - RING_OUTSET,
      top: page.y + (target.y - target.height / 2) * page.height - RING_OUTSET,
      width: target.width * page.width + RING_OUTSET * 2,
      height: target.height * page.height + RING_OUTSET * 2,
    }
    : null;
  return { point, ring };
}

/**
 * The agent's hand on a page or a stream: its mark rides a small pointer that travels to where it is
 * acting, and a cased ring outlines the element when the target has one. A cased outline, as the
 * annotation marks draw it: a casing just outside the line, so one of the two always separates from
 * whatever content is underneath. Decorative and non-interactive (it never intercepts input) and hidden
 * from assistive technology, which hears the same thing from the presence capsule's narration. Reduced
 * motion: no travel or fade, the cursor and ring simply appear at the target and vanish when it ends.
 * Extracted from Happier's browser agent cursor with its geometry and choreography intact.
 */
export function HappierAgentCursor<Motion extends HappierAgentCursorMotion>(
  props: HappierAgentCursorProps<Motion>,
): ReactElement {
  const { reducedMotion } = props;
  const motion = props.motion.useMotion();
  const [size, setSize] = useState<Readonly<{ width: number; height: number }> | null>(null);
  const placedRef = useRef(false);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize((current) => (current && current.width === width && current.height === height ? current : { width, height }));
  }, []);

  // Each new point id is presented once: it arrives, holds while the live target is still there, then
  // leaves. The point that is already there at mount belongs to an earlier action and is not replayed.
  const [seenPointId, setSeenPointId] = useState(props.point?.id ?? null);
  const [heldPoint, setHeldPoint] = useState<HappierAgentPoint | null>(null);
  const [arrivedPointId, setArrivedPointId] = useState<string | null>(null);
  if (props.point && props.point.id !== seenPointId) {
    setSeenPointId(props.point.id);
    setHeldPoint(props.point);
  } else if (!props.point && heldPoint) {
    setHeldPoint(null);
  }
  const held = props.point && heldPoint?.id === props.point.id ? props.point : null;
  const leaving = held !== null && !props.target && !reducedMotion && arrivedPointId === held.id;
  const target = props.target ?? (held && !leaving ? held.target : null);
  const heldArriving = held !== null && arrivedPointId !== held.id ? held.id : null;

  const page = props.pageRect ?? (size ? { x: 0, y: 0, width: size.width, height: size.height } : null);
  const { point, ring } = resolveHappierAgentCursorPlacement(target, page);
  // The hand and its ring stay mounted while they fade out, so leaving is a fade where the agent last
  // acted rather than a blink; they mount only once something has been shown.
  const [shown, setShown] = useState(false);
  if (point && !shown) setShown(true);

  useEffect(() => {
    if (!point) {
      if (reducedMotion) {
        motion.setOpacity('pointer', 0);
        motion.setOpacity('ring', 0);
        placedRef.current = false;
      } else {
        // Once the hand is gone the next target appears in place; a target that arrives while it is
        // still leaving redirects the fade, never reaches this callback, and is travelled to.
        motion.fade('pointer', 0, 'exit', () => {
          placedRef.current = false;
        });
        motion.fade('ring', 0, 'exit');
      }
      return;
    }
    // The first placement appears in place; later targets are travelled to: the hand and the ring move
    // together on one spring, and a new target redirects both mid-way.
    const travel = !reducedMotion && placedRef.current;
    const to = (channel: HappierAgentCursorChannel, value: number) => {
      if (travel) motion.travel(channel, value);
      else motion.set(channel, value);
    };
    to('x', point.x);
    to('y', point.y);
    if (ring) {
      // A ring that was not drawn for the last target grows out of the hand instead of sliding in from
      // where an older one was.
      if (travel && motion.ringOpacity() === 0) {
        motion.set('ringLeft', point.x);
        motion.set('ringTop', point.y);
        motion.set('ringWidth', 0);
        motion.set('ringHeight', 0);
      }
      to('ringLeft', ring.left);
      to('ringTop', ring.top);
      to('ringWidth', ring.width);
      to('ringHeight', ring.height);
    }
    placedRef.current = true;
    if (reducedMotion) motion.setOpacity('pointer', 1);
    else {
      // A held point may only leave once the hand has fully arrived, so the shortest action is still seen.
      const arrivingId = heldArriving;
      motion.fade('pointer', 1, 'standard', arrivingId ? () => setArrivedPointId(arrivingId) : undefined);
    }
    if (reducedMotion) motion.setOpacity('ring', ring ? 1 : 0);
    else motion.fade('ring', ring ? 1 : 0, 'standard');
  }, [motion, point?.x, point?.y, reducedMotion, ring?.left, ring?.top, ring?.width, ring?.height, heldArriving]); // eslint-disable-line react-hooks/exhaustive-deps

  const { Pointer, Ring } = props.motion;
  return (
    <View
      style={styles.layer}
      pointerEvents="none"
      onLayout={onLayout}
      aria-hidden
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID={props.testID}
    >
      {shown ? (
        <Ring motion={motion} style={[styles.ring, { borderColor: props.colors.line }]} testID={`${props.testID}-ring`}>
          <View style={[styles.ringCasing, { borderColor: props.colors.casing }]} />
        </Ring>
      ) : null}
      {shown ? (
        <Pointer motion={motion} style={styles.cursor} testID={`${props.testID}-pointer`}>
          {props.renderGlyph('pointer', props.colors.line, CURSOR_SIZE)}
          <View style={[styles.mark, { backgroundColor: props.colors.casing, borderColor: props.colors.line }]}>
            {props.renderAgentMark ? props.renderAgentMark(MARK_GLYPH_SIZE) : null}
          </View>
        </Pointer>
      ) : null}
    </View>
  );
}

type InstantCursorState = Readonly<Record<HappierAgentCursorChannel | 'pointer' | 'ring', number>>;

type InstantCursorMotion = HappierAgentCursorMotion & Readonly<{
  read: () => InstantCursorState;
  subscribe: (listener: () => void) => () => void;
}>;

function createInstantCursorMotion(): InstantCursorMotion {
  let state: InstantCursorState = { x: 0, y: 0, ringLeft: 0, ringTop: 0, ringWidth: 0, ringHeight: 0, pointer: 0, ring: 0 };
  const listeners = new Set<() => void>();
  const write = (key: keyof InstantCursorState, value: number) => {
    if (state[key] === value) return;
    state = { ...state, [key]: value };
    for (const listener of listeners) listener();
  };
  return {
    set: write,
    travel: write,
    setOpacity: write,
    fade: (layer, to, _curve, onDone) => {
      write(layer, to);
      onDone?.();
    },
    ringOpacity: () => state.ring,
    read: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function useInstantCursorState(motion: InstantCursorMotion): InstantCursorState {
  return useSyncExternalStore(motion.subscribe, motion.read, motion.read);
}

function InstantPointer(props: HappierAgentCursorLayerProps<HappierAgentCursorMotion>): ReactElement {
  // The instant driver's own motion object, handed back by its own `useMotion`.
  const state = useInstantCursorState(props.motion as InstantCursorMotion);
  return (
    <View
      testID={props.testID}
      style={[props.style, { opacity: state.pointer, transform: [{ translateX: state.x }, { translateY: state.y }] }]}
    >
      {props.children}
    </View>
  );
}

function InstantRing(props: HappierAgentCursorLayerProps<HappierAgentCursorMotion>): ReactElement {
  const state = useInstantCursorState(props.motion as InstantCursorMotion);
  return (
    <View
      testID={props.testID}
      style={[props.style, {
        opacity: state.ring,
        left: state.ringLeft,
        top: state.ringTop,
        width: state.ringWidth,
        height: state.ringHeight,
      }]}
    >
      {props.children}
    </View>
  );
}

/**
 * Where no host drives motion (a hosted-web realm, a test), the hand and its ring land at once: the same
 * end states, no travel and no fade. The honest reduced experience, not an imitation of the host's curves.
 */
export const HAPPIER_INSTANT_AGENT_CURSOR_MOTION: HappierAgentCursorMotionDriver = Object.freeze({
  useMotion: () => useMemo(() => createInstantCursorMotion(), []),
  Pointer: InstantPointer,
  Ring: InstantRing,
});
