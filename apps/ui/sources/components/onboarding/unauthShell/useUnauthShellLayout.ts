import { useWindowDimensions } from 'react-native';

import { useBrandHeroSeenAt } from './useBrandHeroSeenAt';

export type UnauthShellLayout = 'split' | 'mobile-hero' | 'mobile-workflow';

export type UnauthShellLayoutParams = Readonly<{
    /**
     * Whether the one-time mobile brand hero is allowed for the current route
     * / wizard step. False for restore, OAuth callback, mTLS callback, and
     * setup deep links so a fresh-device user never gets a brand prelude in
     * front of an urgent recovery flow.
     */
    allowMobileBrandHero: boolean;
}>;

/**
 * Mobile breakpoint shared with the shell mock layout.
 * Width > MOBILE_MAX_WIDTH_PX → desktop split view.
 * Width ≤ MOBILE_MAX_WIDTH_PX → mobile (hero or workflow).
 */
export const MOBILE_MAX_WIDTH_PX = 720;

/**
 * Resolves which of the three unauth shell layouts is active right now.
 *
 * - `'split'` — desktop two-pane (brand left, workflow right).
 * - `'mobile-hero'` — one-time mobile prelude (brand fullscreen + "Get started").
 *   Only ever returned when `allowMobileBrandHero` is true AND
 *   `brandHeroSeenAt` is still null (the user has not dismissed it on this
 *   device).
 * - `'mobile-workflow'` — full-screen workflow content on mobile, with no
 *   brand pane.
 *
 * The hook re-runs on every render. `useWindowDimensions` triggers re-renders
 * on viewport change, and `useBrandHeroSeenAt` triggers re-renders when the
 * local setting flips.
 */
export function useUnauthShellLayout(params: UnauthShellLayoutParams): UnauthShellLayout {
    const { width } = useWindowDimensions();
    const brandHeroSeenAt = useBrandHeroSeenAt();

    const isMobile = width <= MOBILE_MAX_WIDTH_PX;
    if (!isMobile) {
        return 'split';
    }
    if (params.allowMobileBrandHero && brandHeroSeenAt == null) {
        return 'mobile-hero';
    }
    return 'mobile-workflow';
}
