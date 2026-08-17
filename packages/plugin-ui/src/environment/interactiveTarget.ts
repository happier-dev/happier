import { useOptionalHappierUiPlatform } from './context.js';

/** The baseline used by iOS and pointer-oriented platform adapters. */
export const HAPPIER_DEFAULT_MINIMUM_INTERACTIVE_TARGET_SIZE = 44;

/** Android's platform requirement is intentionally stricter than the baseline. */
export const HAPPIER_ANDROID_MINIMUM_INTERACTIVE_TARGET_SIZE = 48;

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
