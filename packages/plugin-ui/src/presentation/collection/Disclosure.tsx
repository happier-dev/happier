import {
  cloneElement,
  isValidElement,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';

import type { HappierLayoutChangeEvent, HappierPortableStyle, HappierStyleProp } from '../portableTypes.js';
import { HAPPIER_PAGE_METRICS } from '../layout/pageMetrics.js';
import { HAPPIER_MOTION_V1 } from '../interaction/motion.js';

/**
 * The disclosure (peek) contract: the Collection's `peek` detail and every shallow accordion row.
 *
 * - WAI-ARIA disclosure semantics: the caller's header becomes the toggle through `headerProps`.
 * - Height and opacity move together, and only the toggled item moves.
 * - The body follows its content: a reveal chases a body that grows or shrinks while it runs, and
 *   once settled the body is released to its natural height (`auto` on web), so later growth is
 *   never clipped.
 * - A hairline sits only BETWEEN items, never inside one: below the header while collapsed, below the
 *   body while expanded, and none after the last item.
 *
 * Motion is the host's: it injects a {@link HappierDisclosureMotionDriver} (Happier core drives it with
 * Reanimated, which stays host-private), exactly as it supplies reduced motion.
 */
export type HappierDisclosureHeaderState = Readonly<{
  expanded: boolean;
  toggle: () => void;
  headerProps: Readonly<{
    onPress: () => void;
    accessibilityRole: 'button';
    accessibilityState: Readonly<{ expanded: boolean }>;
  }>;
}>;

export type HappierDisclosureHeaderRender =
  | ReactNode
  | ((state: HappierDisclosureHeaderState) => ReactNode);

/** One disclosure's animated values, created by the host driver. */
export type HappierDisclosureMotion = Readonly<{
  setHeight: (value: number) => void;
  animateHeight: (to: number, durationMs: number, onFinished: () => void) => void;
  setOpacity: (value: number) => void;
  animateOpacity: (to: number, durationMs: number) => void;
  cancel: () => void;
}>;

export type HappierDisclosureBodyProps<Motion extends HappierDisclosureMotion> = Readonly<{
  motion: Motion;
  /** Pinned to the animated height during a reveal; otherwise at the content's natural height. */
  pinned: boolean;
  style: HappierStyleProp;
  testID?: string;
  children: ReactNode;
}>;

export type HappierDisclosureMotionDriver<Motion extends HappierDisclosureMotion = HappierDisclosureMotion> = Readonly<{
  useMotion: (initiallyExpanded: boolean) => Motion;
  Body: ComponentType<HappierDisclosureBodyProps<Motion>>;
}>;

export type HappierDisclosureProps<Motion extends HappierDisclosureMotion = HappierDisclosureMotion> = Readonly<{
  expanded: boolean;
  onExpandedChange: (next: boolean) => void;
  header: HappierDisclosureHeaderRender;
  children?: ReactNode;
  reorderHandle?: ReactNode;
  /** The inter-item hairline below this item; a group passes `false` for its last row. */
  showDivider?: boolean;
  testID?: string;
  reducedMotion: boolean;
  motion: HappierDisclosureMotionDriver<Motion>;
  /** The host's colour for the inter-item hairline. */
  separatorStyle?: HappierStyleProp;
  /**
   * Called when a reveal or a collapse has settled (at once under reduced motion). A caller that keeps a
   * collapsing body mounted in its own structure (a virtualized peek row) releases it here.
   */
  onSettled?: (expanded: boolean) => void;
}>;

export const HAPPIER_DISCLOSURE_DURATION_MS = HAPPIER_MOTION_V1.baseMs;

/** The lifted row frame shared by public expansions and core attention rows; callers own only colour and body inset. */
export function resolveHappierDisclosureFrameStyle(input: Readonly<{
  expanded: boolean;
  borderColor: string;
  backgroundColor: string;
  shadowColor?: string;
}>): ViewStyle {
  return {
    borderRadius: HAPPIER_PAGE_METRICS.sheetRadiusPx,
    borderWidth: 1,
    borderColor: input.expanded ? input.borderColor : 'transparent',
    backgroundColor: input.expanded ? input.backgroundColor : 'transparent',
    marginTop: input.expanded ? 2 : 0,
    marginBottom: input.expanded ? 8 : 0,
    ...(input.expanded ? {
      shadowColor: input.shadowColor ?? '#000',
      shadowOpacity: 0.06,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 2 },
    } : {}),
  };
}

// Sub-pixel layout jitter must not re-arm the reveal. Only a real change in the body's natural height
// (an async skeleton settling into real rows) re-drives the pinned expand.
const HEIGHT_EPSILON = 1;

// The thinnest line that still paints on every platform (a zero hairline collapses on web/Android).
const HAIRLINE = StyleSheet.hairlineWidth || 0.5;

const headerRowStyle: ViewStyle = { flexDirection: 'row', alignItems: 'center' };
const reorderHandleStyle: ViewStyle = { justifyContent: 'center' };
const headerFlexStyle: ViewStyle = { flex: 1, minWidth: 0 };
const bodyClipStyle: HappierPortableStyle = { overflow: 'hidden' };
// A faint line rather than a hard rule; the host supplies the colour.
const separatorStyle: ViewStyle = { height: HAIRLINE, opacity: 0.6, marginLeft: 16 };

function HappierDisclosureImpl<Motion extends HappierDisclosureMotion>(props: HappierDisclosureProps<Motion>): ReactElement {
  const { expanded, onExpandedChange, header, children, reorderHandle, testID, reducedMotion } = props;
  const onSettledRef = useRef(props.onSettled);
  onSettledRef.current = props.onSettled;
  const showDivider = props.showDivider ?? true;
  const Body = props.motion.Body;
  const motion = props.motion.useMotion(expanded);

  const toggle = useCallback(() => {
    onExpandedChange(!expanded);
  }, [expanded, onExpandedChange]);

  const headerProps = useMemo<HappierDisclosureHeaderState['headerProps']>(() => ({
    onPress: toggle,
    accessibilityRole: 'button',
    accessibilityState: { expanded },
  }), [toggle, expanded]);

  const measuredHeightRef = useRef(0);
  const isMountedRef = useRef(true);
  // "Has the expand armed yet?" — true from the expand until the first height command. It is not the
  // only correctness gate: `handleBodyLayout` reconciles an in-flight expand to the freshest height.
  const pendingExpandRef = useRef(false);
  const prevExpandedRef = useRef(expanded);
  // Where the pinned expand is heading, compared with fresh measurements.
  const animationTargetRef = useRef(0);
  // `heightPinned`, readable synchronously in `handleBodyLayout` (onLayout may fire on a stale closure).
  const heightPinnedRef = useRef(false);

  const [bodyMounted, setBodyMounted] = useState(expanded);
  const [heightPinned, setHeightPinned] = useState(false);

  const applyHeightPinned = useCallback((next: boolean) => {
    heightPinnedRef.current = next;
    setHeightPinned(next);
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      motion.cancel();
    };
  }, [motion]);

  const settleExpanded = useCallback(() => {
    if (!isMountedRef.current) return;
    // Release the pin so the body renders at natural height and can grow.
    applyHeightPinned(false);
    onSettledRef.current?.(true);
  }, [applyHeightPinned]);

  const settleCollapsed = useCallback(() => {
    if (!isMountedRef.current) return;
    setBodyMounted(false);
    applyHeightPinned(false);
    onSettledRef.current?.(false);
  }, [applyHeightPinned]);

  const armExpandTiming = useCallback((target: number) => {
    animationTargetRef.current = target;
    motion.animateHeight(target, HAPPIER_DISCLOSURE_DURATION_MS, settleExpanded);
  }, [motion, settleExpanded]);

  useEffect(() => {
    if (prevExpandedRef.current === expanded) return;
    prevExpandedRef.current = expanded;

    if (expanded) {
      setBodyMounted(true);
      if (reducedMotion) {
        motion.setOpacity(1);
        applyHeightPinned(false);
        onSettledRef.current?.(true);
        return;
      }
      motion.setHeight(0);
      applyHeightPinned(true);
      pendingExpandRef.current = true;
      animationTargetRef.current = 0;
      motion.animateOpacity(1, HAPPIER_DISCLOSURE_DURATION_MS);
      const target = measuredHeightRef.current;
      if (target > 0) {
        pendingExpandRef.current = false;
        // Fast path to the last known height. It may be stale; `handleBodyLayout` reconciles it.
        armExpandTiming(target);
      }
      return;
    }

    if (reducedMotion) {
      motion.setOpacity(0);
      settleCollapsed();
      return;
    }
    pendingExpandRef.current = false;
    animationTargetRef.current = 0;
    motion.setHeight(measuredHeightRef.current > 0 ? measuredHeightRef.current : 0);
    applyHeightPinned(true);
    motion.animateOpacity(0, HAPPIER_DISCLOSURE_DURATION_MS);
    motion.animateHeight(0, HAPPIER_DISCLOSURE_DURATION_MS, settleCollapsed);
  }, [expanded, reducedMotion, motion, applyHeightPinned, armExpandTiming, settleCollapsed]);

  const handleBodyLayout = useCallback((event: HappierLayoutChangeEvent) => {
    const measured = event.nativeEvent.layout.height;
    if (measured <= 0) return;
    measuredHeightRef.current = measured;
    if (reducedMotion) return;

    if (pendingExpandRef.current) {
      // Initial arm: the expand waited for the first real height.
      pendingExpandRef.current = false;
      armExpandTiming(measured);
      return;
    }

    // Reconcile an in-flight expand whose body changed height after it armed (otherwise the reveal
    // undershoots to the stale height until the timing ends). Once settled, the natural height owns
    // growth, so a settled body is never re-pinned here.
    if (
      expanded
      && heightPinnedRef.current
      && Math.abs(measured - animationTargetRef.current) > HEIGHT_EPSILON
    ) {
      armExpandTiming(measured);
    }
  }, [expanded, reducedMotion, armExpandTiming]);

  // The header never draws its own row separator (a zero-height line on web/Android); the disclosure
  // owns the single inter-item hairline so separation paints the same everywhere.
  const resolvedHeader = typeof header === 'function'
    ? header({ expanded, toggle, headerProps })
    : header;
  const headerNode = isValidElement(resolvedHeader)
    ? cloneElement(resolvedHeader as ReactElement<{ showDivider?: boolean }>, { showDivider: false })
    : resolvedHeader;

  // One wrapper, so a group that injects row position and dividers sees exactly one row slot.
  return (
    <View testID={testID}>
      {reorderHandle != null ? (
        <View style={headerRowStyle}>
          <View style={reorderHandleStyle}>{reorderHandle}</View>
          <View style={headerFlexStyle}>{headerNode}</View>
        </View>
      ) : (
        headerNode
      )}

      {bodyMounted ? (
        <Body
          motion={motion}
          pinned={heightPinned}
          style={bodyClipStyle}
          {...(testID ? { testID: `${testID}:body` } : {})}
        >
          <View onLayout={handleBodyLayout}>
            {children}
          </View>
        </Body>
      ) : null}

      {showDivider ? (
        <View
          testID={testID ? `${testID}:row-divider` : undefined}
          style={[separatorStyle, props.separatorStyle]}
        />
      ) : null}
    </View>
  );
}

export const HappierDisclosure = memo(HappierDisclosureImpl) as typeof HappierDisclosureImpl;
