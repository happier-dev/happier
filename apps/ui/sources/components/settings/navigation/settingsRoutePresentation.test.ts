import { describe, expect, it } from 'vitest';

import { resolveSettingsRouteAnimation, resolveSettingsRoutePresentation } from './settingsRoutePresentation';

describe('resolveSettingsRoutePresentation', () => {
    it('keeps settings as a full-screen screen on phones (reached via the bottom tab bar)', () => {
        // Phones surface settings through the bottom tab bar; the nav sidebar is hidden
        // at this size (window min-edge < 600px → deviceType === 'phone'), so the route
        // must stay a plain screen rather than a modal.
        expect(resolveSettingsRoutePresentation({ deviceType: 'phone', platformOs: 'ios' })).toBeUndefined();
        expect(resolveSettingsRoutePresentation({ deviceType: 'phone', platformOs: 'web' })).toBeUndefined();
        expect(resolveSettingsRoutePresentation({ deviceType: 'phone', platformOs: 'android' })).toBeUndefined();
    });

    it('presents settings as a contained modal on iOS tablets', () => {
        expect(resolveSettingsRoutePresentation({ deviceType: 'tablet', platformOs: 'ios' })).toBe('containedModal');
    });

    it('presents settings as a stack modal on web and android tablet/desktop layouts', () => {
        expect(resolveSettingsRoutePresentation({ deviceType: 'tablet', platformOs: 'web' })).toBe('modal');
        expect(resolveSettingsRoutePresentation({ deviceType: 'tablet', platformOs: 'android' })).toBe('modal');
    });
});

describe('resolveSettingsRouteAnimation', () => {
    it('suppresses the animation on phones so the settings tab switches instantly', () => {
        expect(resolveSettingsRouteAnimation({ deviceType: 'phone' })).toBe('none');
    });

    it('inherits the default modal animation on tablet/desktop (modal mode only)', () => {
        // `undefined` means "use the platform default modal animation"; crucially it is NOT
        // 'none', so the modal animates in while the phone tab still does not.
        expect(resolveSettingsRouteAnimation({ deviceType: 'tablet' })).toBeUndefined();
    });
});
