import { describe, expect, it } from 'vitest';

import { buildUniversalSearchRouteScreenOptions } from './universalSearchRouteScreenOptions';

/**
 * UNIVERSAL-SEARCH §7.3 — the canonical `/search` route presents the
 * universal Search surface. On iOS/Android it is a transparent full-screen
 * overlay over the screen behind it; on web/desktop it stays an ordinary
 * opaque deep-linkable screen. The layout registers exactly this projection.
 */
describe('universal Search route screen options', () => {
    it.each([
        ['iOS', 'ios'],
        ['Android', 'android'],
    ] as const)('presents native %s Search as a transparent overlay without app chrome', (_name, platformOs) => {
        expect(buildUniversalSearchRouteScreenOptions({ platformOs })).toEqual({
            headerShown: false,
            presentation: 'transparentModal',
            // The app stack supplies an opaque `surface.base` contentStyle for
            // every screen; the overlay paints its own scrim and must not
            // inherit it.
            contentStyle: { backgroundColor: 'transparent' },
            // The Search host owns the scrim transition. Native-stack motion would move the
            // barrier and prior-screen context as a second, bypassable lifecycle.
            animation: 'none',
            gestureEnabled: false,
            fullScreenGestureEnabled: false,
        });
    });

    it('keeps web/desktop on the ordinary opaque router presentation', () => {
        expect(buildUniversalSearchRouteScreenOptions({ platformOs: 'web' })).toEqual({
            headerShown: false,
        });
        expect(buildUniversalSearchRouteScreenOptions({ platformOs: 'macos' })).toEqual({
            headerShown: false,
        });
    });
});
