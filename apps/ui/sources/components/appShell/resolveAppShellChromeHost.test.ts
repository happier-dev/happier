import { describe, expect, it } from 'vitest';

import {
    resolveAppShellChromeHost,
    type ResolveAppShellChromeHostParams,
} from './resolveAppShellChromeHost';

describe('resolveAppShellChromeHost', () => {
    it('returns none for terminal-connect routes', () => {
        expect(resolveAppShellChromeHost({
            isAuthenticated: true,
            isDesktopHost: true,
            isTablet: true,
            isTerminalConnectRoute: true,
        })).toBe('none');
    });

    it('returns unauth-shell for unauthenticated desktop flows', () => {
        expect(resolveAppShellChromeHost({
            isAuthenticated: false,
            isDesktopHost: true,
            isTablet: true,
            isTerminalConnectRoute: false,
        })).toBe('unauth-shell');
    });

    it('adds no floating root chrome to browser shells (the sidebar and header own the Updates entry)', () => {
        expect(resolveAppShellChromeHost({
            isAuthenticated: false,
            isDesktopHost: false,
            isTablet: true,
            isTerminalConnectRoute: false,
        })).toBe('none');
    });

    it('does not place root update chrome over native mobile headers', () => {
        const params = {
            isAuthenticated: true,
            isDesktopHost: false,
            isTablet: false,
            isTerminalConnectRoute: false,
        } as ResolveAppShellChromeHostParams;

        expect(resolveAppShellChromeHost(params)).toBe('none');
    });

    it('keeps authenticated wide desktop shell chrome in the sidebar host', () => {
        expect(resolveAppShellChromeHost({
            isAuthenticated: true,
            isDesktopHost: true,
            isTablet: true,
            isTerminalConnectRoute: false,
        })).toBe('none');
    });

    it('returns narrow-desktop-fallback when the desktop shell is too narrow for the sidebar host', () => {
        expect(resolveAppShellChromeHost({
            isAuthenticated: true,
            isDesktopHost: true,
            isTablet: false,
            isTerminalConnectRoute: false,
        })).toBe('narrow-desktop-fallback');
    });

});
