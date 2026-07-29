import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';

/**
 * Motion-preference-gated haptics for the instrument kit. Every kit haptic goes
 * through here so it respects the resolved motion budget and no-ops on web.
 *
 * `enabled` is the caller's already-resolved `useMotionPreferences().hapticsEnabled`
 * (false on web and at `minimal`). We still guard `Platform.OS === 'web'` here as a
 * belt-and-braces boundary so a mis-wired caller can never fire native-only APIs on
 * web. All calls are fire-and-forget; failures are swallowed (haptics are cosmetic).
 */

function isWeb(): boolean {
    return Platform.OS === 'web';
}

function fireAndForget(run: () => Promise<unknown>): void {
    try {
        void run().catch(() => {
            /* haptics are best-effort; ignore rejection */
        });
    } catch {
        /* synchronous throw on unsupported platforms — ignore */
    }
}

/**
 * Light selection tick — for a value stepping to a new glyph, a chip toggling,
 * or a discrete instrument state change.
 */
export function instrumentSelectionTick(enabled: boolean): void {
    if (!enabled || isWeb()) return;
    fireAndForget(() => Haptics.selectionAsync());
}

/**
 * Threshold-cross impact — the gauge fill crossing an attention threshold
 * (e.g. 75% / 90% context). Heavier than a selection tick; use sparingly.
 */
export function instrumentThresholdImpact(enabled: boolean): void {
    if (!enabled || isWeb()) return;
    fireAndForget(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium));
}
