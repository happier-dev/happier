import { describe, expect, it } from 'vitest';

import {
    resolveAppShellChromeHost,
    type ResolveAppShellChromeHostParams,
} from './resolveAppShellChromeHost';

describe('resolveAppShellChromeHost', () => {
    it('returns none for terminal-connect routes', () => {
        expect(resolveAppShellChromeHost({
            isAuthenticated: true,
            isWeb: true,
            isDesktopHost: true,
            isTablet: true,
            isTerminalConnectRoute: true,
        })).toBe('none');
    });

    it('returns unauth-shell for unauthenticated desktop flows', () => {
        expect(resolveAppShellChromeHost({
            isAuthenticated: false,
            isWeb: true,
            isDesktopHost: true,
            isTablet: true,
            isTerminalConnectRoute: false,
        })).toBe('unauth-shell');
    });

    it('returns web-top-right for non-desktop browser shells', () => {
        expect(resolveAppShellChromeHost({
            isAuthenticated: false,
            isWeb: true,
            isDesktopHost: false,
            isTablet: true,
            isTerminalConnectRoute: false,
        })).toBe('web-top-right');
    });

    it('does not place root update chrome over native mobile headers', () => {
        const params = {
            isAuthenticated: true,
            isWeb: false,
            isDesktopHost: false,
            isTablet: false,
            isTerminalConnectRoute: false,
        } as ResolveAppShellChromeHostParams & { isWeb: boolean };

        expect(resolveAppShellChromeHost(params)).toBe('none');
    });

    it('keeps authenticated wide desktop shell chrome in the sidebar host', () => {
        expect(resolveAppShellChromeHost({
            isAuthenticated: true,
            isWeb: true,
            isDesktopHost: true,
            isTablet: true,
            isTerminalConnectRoute: false,
        })).toBe('none');
    });

    it('returns narrow-desktop-fallback when the desktop shell is too narrow for the sidebar host', () => {
        expect(resolveAppShellChromeHost({
            isAuthenticated: true,
            isWeb: true,
            isDesktopHost: true,
            isTablet: false,
            isTerminalConnectRoute: false,
        })).toBe('narrow-desktop-fallback');
    });

    it('returns none when the authenticated desktop sidebar host should stay in the sidebar', () => {
        expect(resolveAppShellChromeHost({
            isAuthenticated: true,
            isWeb: true,
            isDesktopHost: true,
            isTablet: true,
            isTerminalConnectRoute: false,
        })).toBe('none');
    });
});
