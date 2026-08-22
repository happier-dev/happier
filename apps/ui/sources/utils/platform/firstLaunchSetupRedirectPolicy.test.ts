import { describe, expect, it } from 'vitest';

import { shouldAutoRedirectToSetupOnFirstLaunch } from './firstLaunchSetupRedirectPolicy';

describe('shouldAutoRedirectToSetupOnFirstLaunch', () => {
    it('returns false on iOS/Android even when Tauri is available', () => {
        expect(shouldAutoRedirectToSetupOnFirstLaunch({ platformOs: 'ios', isDesktopHost: true })).toBe(false);
        expect(shouldAutoRedirectToSetupOnFirstLaunch({ platformOs: 'android', isDesktopHost: true })).toBe(false);
    });

    it('returns false in browser-web (not Tauri)', () => {
        expect(shouldAutoRedirectToSetupOnFirstLaunch({ platformOs: 'web', isDesktopHost: false })).toBe(false);
    });

    it('returns true in Tauri desktop webview', () => {
        expect(shouldAutoRedirectToSetupOnFirstLaunch({ platformOs: 'web', isDesktopHost: true })).toBe(true);
    });
});
