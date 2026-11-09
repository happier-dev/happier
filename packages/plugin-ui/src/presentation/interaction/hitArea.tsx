import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { Platform, View } from 'react-native';

import type { HappierLayoutChangeEvent } from '../portableTypes.js';

import {
  resolveHappierHitInsets,
  resolveHappierInteractiveTargetFloor,
  useHappierTouchTargetSize,
  type HappierHitInsets,
  type HappierHitReach,
} from '../../environment/interactiveTarget.js';

type HitSlop = number | Readonly<{ top?: number; bottom?: number; left?: number; right?: number }>;

/** Web only: marks the invisible hit frame for the browser and for QA probes. */
const HIT_AREA_DATA_SET = { dataSet: { happierHitArea: 'true' } } as Record<string, unknown>;

function readDimension(exact: unknown, minimum: unknown): number | undefined {
  if (typeof exact === 'number') return exact;
  return typeof minimum === 'number' ? minimum : undefined;
}

type DeclaredStyle = {
  width?: unknown; height?: unknown; minWidth?: unknown; minHeight?: unknown;
  borderWidth?: unknown; borderTopWidth?: unknown; borderBottomWidth?: unknown; borderLeftWidth?: unknown; borderRightWidth?: unknown;
};

const DECLARED_KEYS = [
  'width', 'height', 'minWidth', 'minHeight',
  'borderWidth', 'borderTopWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderRightWidth',
] as const satisfies readonly (keyof DeclaredStyle)[];

/** Later entries win, as in a style array; only the size and border-width keys are read. */
function collectDeclared(style: unknown, into: DeclaredStyle): void {
  if (Array.isArray(style)) {
    for (const entry of style) collectDeclared(entry, into);
    return;
  }
  if (style === null || typeof style !== 'object') return;
  const entry = style as DeclaredStyle;
  for (const key of DECLARED_KEYS) {
    if (entry[key] !== undefined) into[key] = entry[key];
  }
}

function borderSide(specific: unknown, all: unknown): number {
  const value = typeof specific === 'number' ? specific : all;
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

type DeclaredBox = Readonly<{
  width?: number;
  height?: number;
  /** The host's border widths: an absolutely positioned child is offset from the padding edge, inside them. */
  border: HappierHitInsets;
}>;

/** The drawn size and border widths a resting style declares; an axis sized by its content stays unknown until layout. */
function readDeclaredBox(style: unknown): DeclaredBox {
  const declared: DeclaredStyle = {};
  collectDeclared(style, declared);
  return {
    width: readDimension(declared.width, declared.minWidth),
    height: readDimension(declared.height, declared.minHeight),
    border: {
      top: borderSide(declared.borderTopWidth, declared.borderWidth),
      bottom: borderSide(declared.borderBottomWidth, declared.borderWidth),
      left: borderSide(declared.borderLeftWidth, declared.borderWidth),
      right: borderSide(declared.borderRightWidth, declared.borderWidth),
    },
  };
}

function sameHitInsets(a: HappierHitInsets | undefined, b: HappierHitInsets | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.top === b.top && a.bottom === b.bottom && a.left === b.left && a.right === b.right;
}

/**
 * The hit-area mechanism of a pressable: the control keeps its drawn box and layout, and under a
 * finger (or a declared `hitTarget`) its hit area reaches past that box — `hitSlop` on native, an
 * invisible absolutely positioned `frame` on the web, whose Pressable ignores `hitSlop`. Both reach
 * past the drawn OUTER box: native `hitSlop` is measured from the view bounds (border included), and
 * the web frame adds the host's border widths because it is offset from the padding edge. The caller
 * renders `frame` as the pressable's first child and forwards `hitSlop` and `onLayout`.
 *
 * Nothing between the pressable and the space its hit area reaches into may clip: not the pressable
 * itself, not a box that paints a few controls together (a compact stepper, a tile frame). A clipping
 * edge cuts the reach off on the web and on native alike (a view outside its clipping parent is never
 * hit-tested). Rounded paint that needs clipping goes on a noninteractive inner or backing view; a real
 * clipping edge (a scroll viewport, a card) bounds the reach through `hitReach` instead.
 *
 * `HappierPressable` uses this; a control built on a raw platform pressable (a ref-forwarding chip,
 * the native switch) uses it directly rather than keeping a second target policy.
 */
export function useHappierHitArea(input: Readonly<{
  /** The resting style, read only while a hit area applies; it gives the drawn size before layout. */
  restingStyle: () => unknown;
  hitTarget?: number;
  hitReach?: HappierHitReach;
  /** A precise pointer's own reach, forwarded unchanged where no hit area applies. */
  hitSlop?: HitSlop;
}>): Readonly<{
  hitSlop: HitSlop | undefined;
  onLayout: ((event: HappierLayoutChangeEvent) => void) | undefined;
  frame: ReactNode;
}> {
  const target = resolveHappierInteractiveTargetFloor(input.hitTarget, useHappierTouchTargetSize());
  const [measured, setMeasured] = useState<Readonly<{ width: number; height: number }> | null>(null);
  // The drawn size comes from the declared resting style until layout measures it (the outer box,
  // border included), so a control with a declared size never re-renders to learn it. The border
  // widths always come from the style: the web frame is offset from the padding edge.
  const declared = target === undefined ? undefined : readDeclaredBox(input.restingStyle());
  const drawn = measured ?? declared;
  const insets = target === undefined
    ? undefined
    : resolveHappierHitInsets({ width: drawn?.width, height: drawn?.height, target, reach: input.hitReach });
  const insetsRef = useRef(insets);
  insetsRef.current = insets;
  const policyRef = useRef({ target, reach: input.hitReach });
  policyRef.current = { target, reach: input.hitReach };
  const onLayout = useCallback((event: HappierLayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    if (sameHitInsets(resolveHappierHitInsets({ width, height, ...policyRef.current }), insetsRef.current)) return;
    setMeasured({ width, height });
  }, []);

  const web = Platform.OS === 'web';
  const top = insets?.top ?? 0;
  const bottom = insets?.bottom ?? 0;
  const left = insets?.left ?? 0;
  const right = insets?.right ?? 0;
  const borderTop = declared?.border.top ?? 0;
  const borderBottom = declared?.border.bottom ?? 0;
  const borderLeft = declared?.border.left ?? 0;
  const borderRight = declared?.border.right ?? 0;
  const hasInsets = insets !== undefined;
  const callerHitSlop = input.hitSlop;
  // Stable while the insets hold, so a caller can keep its memoized render callbacks.
  return useMemo(() => {
    if (target === undefined) return { hitSlop: callerHitSlop, onLayout: undefined, frame: null };
    const resolved = hasInsets ? { top, bottom, left, right } : undefined;
    if (!web) return { hitSlop: resolved, onLayout, frame: null };
    return {
      hitSlop: undefined,
      onLayout,
      frame: resolved === undefined ? null : (
        <View
          aria-hidden
          {...HIT_AREA_DATA_SET}
          style={{
            position: 'absolute',
            top: -(top + borderTop),
            bottom: -(bottom + borderBottom),
            left: -(left + borderLeft),
            right: -(right + borderRight),
          }}
        />
      ),
    };
  }, [borderBottom, borderLeft, borderRight, borderTop, bottom, callerHitSlop, hasInsets, left, onLayout, right, target, top, web]);
}
