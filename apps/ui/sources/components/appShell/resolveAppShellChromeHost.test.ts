import { describe, expect, it } from 'vitest';

import { resolveAppShellChromeHost } from './resolveAppShellChromeHost';

describe('resolveAppShellChromeHost', () => {
    it('returns none for terminal-connect routes', () => {
        expect(resolveAppShellChromeHost({
            isAuthenticated: true,
            isTauriDesktop: true,
            isTablet: true,
            isTerminalConnectRoute: true,
        })).toBe('none');
    });

    it('returns unauth-shell for unauthenticated desktop flows', () => {
        expect(resolveAppShellChromeHost({
            isAuthenticated: false,
            isTauriDesktop: true,
            isTablet: true,
            isTerminalConnectRoute: false,
        })).toBe('unauth-shell');
    });

    it('returns web-top-right for non-desktop shells', () => {
        expect(resolveAppShellChromeHost({
            isAuthenticated: false,
            isTauriDesktop: false,
            isTablet: true,
            isTerminalConnectRoute: false,
        })).toBe('web-top-right');
    });

    it('keeps authenticated wide desktop shell chrome in the sidebar host', () => {
        expect(resolveAppShellChromeHost({
            isAuthenticated: true,
            isTauriDesktop: true,
            isTablet: true,
            isTerminalConnectRoute: false,
        })).toBe('none');
    });

    it('returns narrow-desktop-fallback when the desktop shell is too narrow for the sidebar host', () => {
        expect(resolveAppShellChromeHost({
            isAuthenticated: true,
            isTauriDesktop: true,
            isTablet: false,
            isTerminalConnectRoute: false,
        })).toBe('narrow-desktop-fallback');
    });

    it('returns none when the authenticated desktop sidebar host should stay in the sidebar', () => {
        expect(resolveAppShellChromeHost({
            isAuthenticated: true,
            isTauriDesktop: true,
            isTablet: true,
            isTerminalConnectRoute: false,
        })).toBe('none');
    });
});
