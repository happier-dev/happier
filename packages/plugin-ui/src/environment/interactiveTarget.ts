import { useSyncExternalStore } from 'react';
import { useOptionalHappierUiPlatform } from './context.js';

/** The baseline used by iOS and pointer-oriented platform adapters. */
export const HAPPIER_DEFAULT_MINIMUM_INTERACTIVE_TARGET_SIZE = 44;

/** Android's platform requirement is intentionally stricter than the baseline. */
export const HAPPIER_ANDROID_MINIMUM_INTERACTIVE_TARGET_SIZE = 48;

/**
 * A precise pointer's floor: WCAG 2.2 AA target size (2.5.8). Dense pointer layouts keep their
 * drawn sizes above it; the touch floors above apply only where the primary pointer is a finger.
 */
export const HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE = 24;

/**
 * The one 44/48 platform policy shared by Happier core adapters and portable
 * presentation. Callers that render dense desktop/web layouts can retain their
 * density by using {@link useHappierNativeMinimumInteractiveTargetSize}, which
 * deliberately applies a physical floor only to native touch platforms.
 */
export function resolveHappierMinimumInteractiveTargetSize(platform: string): 44 | 48 {
  return platform === 'android'
    ? HAPPIER_ANDROID_MINIMUM_INTERACTIVE_TARGET_SIZE
    : HAPPIER_DEFAULT_MINIMUM_INTERACTIVE_TARGET_SIZE;
}

/**
 * Combine an explicit host-requested physical target with the only factual
 * platform floor. Undefined on web/desktop deliberately preserves dense
 * pointer layouts instead of inventing a native touch platform.
 */
export function resolveHappierInteractiveTargetFloor(
  requested: number | undefined,
  nativeMinimum: number | undefined,
): number | undefined {
  const requestedFloor = typeof requested === 'number' && Number.isFinite(requested)
    ? Math.max(0, requested)
    : 0;
  const floor = Math.max(requestedFloor, nativeMinimum ?? 0);
  return floor > 0 ? floor : undefined;
}

/**
 * Reads the mounted provider's platform fact and returns a physical touch floor
 * only where that fact denotes a native touch platform. `undefined` preserves
 * desktop/web density and the behavior of an environment-free core adapter;
 * neither path fabricates a platform fact.
 */
export function useHappierNativeMinimumInteractiveTargetSize(): 44 | 48 | undefined {
  const platform = useOptionalHappierUiPlatform()?.platform;
  return platform === 'android' || platform === 'ios'
    ? resolveHappierMinimumInteractiveTargetSize(platform)
    : undefined;
}

type PointerMediaQuery = {
  readonly matches?: boolean;
  addEventListener?: (type: 'change', listener: () => void) => void;
  removeEventListener?: (type: 'change', listener: () => void) => void;
  addListener?: (listener: () => void) => void;
  removeListener?: (listener: () => void) => void;
};

function readMediaQuery(query: string): PointerMediaQuery | null {
  const match = (globalThis as { matchMedia?: (query: string) => PointerMediaQuery | null }).matchMedia;
  if (typeof match !== 'function') return null;
  try {
    return match.call(globalThis, query);
  } catch {
    return null;
  }
}

function classifyCoarsePrimaryPointer(matches: (query: string) => boolean): boolean {
  if (matches('(pointer: fine)') || matches('(hover: hover)')) return false;
  if (matches('(pointer: coarse)') || matches('(hover: none)')) return true;
  const touchPoints = (globalThis as { navigator?: { maxTouchPoints?: unknown } }).navigator?.maxTouchPoints;
  return typeof touchPoints === 'number' && touchPoints > 0;
}

/**
 * Whether a browser's PRIMARY pointer is a finger (a phone or tablet browser). Only `pointer:` and
 * `hover:` describe the primary pointer: a hover-capable laptop that merely has a touchscreen keeps
 * its precise-pointer density. This synchronous read also works outside React; mounted consumers
 * subscribe through {@link useHappierTouchPrimaryPointer}.
 */
export function isHappierCoarsePrimaryPointer(): boolean {
  return classifyCoarsePrimaryPointer(query => readMediaQuery(query)?.matches === true);
}

const primaryPointerListeners = new Set<() => void>();
let primaryPointerMedia: Map<string, PointerMediaQuery | null> | null = null;
let coarsePrimaryPointer = false;
let precisePrimaryPointer = false;

function readCoarsePrimaryPointerSnapshot(): boolean {
  return primaryPointerMedia === null ? isHappierCoarsePrimaryPointer() : coarsePrimaryPointer;
}

function publishPrimaryPointerChange(): void {
  const coarse = classifyCoarsePrimaryPointer(query => primaryPointerMedia?.get(query)?.matches === true);
  const precise = primaryPointerMedia?.get('(pointer: fine)')?.matches === true && primaryPointerMedia.get('(hover: hover)')?.matches === true;
  if (coarse === coarsePrimaryPointer && precise === precisePrimaryPointer) return;
  coarsePrimaryPointer = coarse;
  precisePrimaryPointer = precise;
  for (const listener of primaryPointerListeners) listener();
}

function subscribePrimaryPointer(listener: () => void): () => void {
  if (primaryPointerMedia === null) {
    primaryPointerMedia = new Map(['(pointer: fine)', '(hover: hover)', '(pointer: coarse)', '(hover: none)']
      .map(query => [query, readMediaQuery(query)]));
    coarsePrimaryPointer = classifyCoarsePrimaryPointer(query => primaryPointerMedia?.get(query)?.matches === true);
    precisePrimaryPointer = primaryPointerMedia.get('(pointer: fine)')?.matches === true && primaryPointerMedia.get('(hover: hover)')?.matches === true;
    for (const media of primaryPointerMedia.values()) {
      if (media?.addEventListener) media.addEventListener('change', publishPrimaryPointerChange);
      else media?.addListener?.(publishPrimaryPointerChange);
    }
  }
  primaryPointerListeners.add(listener);
  return () => {
    primaryPointerListeners.delete(listener);
    if (primaryPointerListeners.size !== 0) return;
    for (const media of primaryPointerMedia?.values() ?? []) {
      if (media?.removeEventListener) media.removeEventListener('change', publishPrimaryPointerChange);
      else media?.removeListener?.(publishPrimaryPointerChange);
    }
    primaryPointerMedia = null;
  };
}

const readNativeTouchPointer = () => true;
const readServerPointer = () => false;
const subscribeNativePointer = () => () => {};

function readPrecisePrimaryPointerSnapshot(): boolean {
  return primaryPointerMedia === null
    ? readMediaQuery('(pointer: fine)')?.matches === true && readMediaQuery('(hover: hover)')?.matches === true
    : precisePrimaryPointer;
}

/** @internal A hover reveal needs both fine pointing and hover; it shares the pointer store's lifetime. */
export function useHappierPrecisePrimaryPointer(platform: string): boolean {
  return useSyncExternalStore(
    platform === 'web' ? subscribePrimaryPointer : subscribeNativePointer,
    platform === 'web' ? readPrecisePrimaryPointerSnapshot : readServerPointer,
    readServerPointer,
  );
}

/**
 * Whether the primary pointer is a finger: always on a native touch platform, and in a browser whose
 * primary pointer cannot hover (a phone or tablet). Density choices that differ by pointer (row
 * heights, page sizes, drag handles) and the hit-area policy below ask this one fact.
 */
export function isHappierTouchPrimaryPointer(platform: string | undefined): boolean {
  return platform === 'android' || platform === 'ios' || isHappierCoarsePrimaryPointer();
}

/** The shared primary-pointer fact, updated when a browser attaches or removes a pointing device. */
export function useHappierTouchPrimaryPointer(platform: string | undefined): boolean {
  const nativeTouch = platform === 'android' || platform === 'ios';
  return useSyncExternalStore(
    nativeTouch ? subscribeNativePointer : subscribePrimaryPointer,
    nativeTouch ? readNativeTouchPointer : readCoarsePrimaryPointerSnapshot,
    nativeTouch ? readNativeTouchPointer : readServerPointer,
  );
}

/**
 * The hit area a finger needs here: 44 (48 on Android) on a native touch platform and in a browser
 * whose primary pointer is a finger, `undefined` under a precise pointer, whose dense layout keeps its
 * own target. It sizes the HIT AREA only; a control keeps its drawn size
 * ({@link resolveHappierHitInsets}).
 */
export function useHappierTouchTargetSize(): 44 | 48 | undefined {
  const platform = useOptionalHappierUiPlatform()?.platform;
  return useHappierTouchPrimaryPointer(platform) ? resolveHappierMinimumInteractiveTargetSize(platform ?? 'web') : undefined;
}

/**
 * How far a control's hit area may reach past its drawn box on each side: half the gap to the
 * neighbouring control, or the free space to a container edge that clips. A number applies to every
 * side; an omitted side may reach as far as the target needs. `0` keeps that side at the drawn edge.
 */
export type HappierHitReach = number | Readonly<{ top?: number; bottom?: number; left?: number; right?: number }>;

export type HappierHitInsets = Readonly<{ top: number; bottom: number; left: number; right: number }>;

function reachOf(reach: HappierHitReach | undefined, side: keyof HappierHitInsets): number {
  const value = typeof reach === 'number' ? reach : reach?.[side];
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : Number.POSITIVE_INFINITY;
}

/**
 * The one hit-area policy: how far beyond a control's DRAWN box its hit area extends so the area
 * reaches `target`, centred on the control and never past the reach it was given. The drawn box and
 * its layout never grow; neighbours that each reach half their gap meet without overlapping. An
 * unknown drawn dimension extends nothing on that axis. `undefined` when nothing extends.
 */
export function resolveHappierHitInsets(input: Readonly<{
  width?: number;
  height?: number;
  target: number | undefined;
  reach?: HappierHitReach;
}>): HappierHitInsets | undefined {
  const { target } = input;
  if (target === undefined || !Number.isFinite(target)) return undefined;
  const deficit = (drawn: number | undefined) => (
    typeof drawn === 'number' && Number.isFinite(drawn) ? Math.max(0, (target - drawn) / 2) : 0
  );
  const x = deficit(input.width);
  const y = deficit(input.height);
  const insets = {
    top: Math.min(y, reachOf(input.reach, 'top')),
    bottom: Math.min(y, reachOf(input.reach, 'bottom')),
    left: Math.min(x, reachOf(input.reach, 'left')),
    right: Math.min(x, reachOf(input.reach, 'right')),
  };
  return insets.top + insets.bottom + insets.left + insets.right > 0 ? insets : undefined;
}
