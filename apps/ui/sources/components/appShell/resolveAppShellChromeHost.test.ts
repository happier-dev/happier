import { describe, expect, it } from 'vitest';

import { resolveAppShellChromeHost } from './resolveAppShellChromeHost';

describe('resolveAppShellChromeHost', () => {
    it('returns none for terminal-connect routes', () => {
        expect(resolveAppShellChromeHost({
            isAuthenticated: true,
            isDesktopPetOverlayWindow: false,
            isTauriDesktop: true,
            isTablet: true,
            isTerminalConnectRoute: true,
        })).toBe('none');
    });

    it('returns none for the desktop pet overlay window', () => {
        expect(resolveAppShellChromeHost({
            isAuthenticated: true,
            isDesktopPetOverlayWindow: true,
            isTauriDesktop: true,
            isTablet: false,
            isTerminalConnectRoute: false,
        })).toBe('none');
    });

    it('returns web-top-right for non-Tauri browser shells', () => {
        expect(resolveAppShellChromeHost({
            isAuthenticated: true,
            isDesktopPetOverlayWindow: false,
            isTauriDesktop: false,
            isTablet: true,
            isTerminalConnectRoute: false,
        })).toBe('web-top-right');
    });

    it('returns unauth-shell for unauthenticated Tauri desktop flows', () => {
        expect(resolveAppShellChromeHost({
            isAuthenticated: false,
            isDesktopPetOverlayWindow: false,
            isTauriDesktop: true,
            isTablet: true,
            isTerminalConnectRoute: false,
        })).toBe('unauth-shell');
    });

    it('returns narrow-desktop-fallback when authenticated Tauri desktop has no permanent sidebar host', () => {
        expect(resolveAppShellChromeHost({
            isAuthenticated: true,
            isDesktopPetOverlayWindow: false,
            isTauriDesktop: true,
            isTablet: false,
            isTerminalConnectRoute: false,
        })).toBe('narrow-desktop-fallback');
    });

    it('returns none for authenticated wide Tauri desktop because the sidebar hosts chrome', () => {
        expect(resolveAppShellChromeHost({
            isAuthenticated: true,
            isDesktopPetOverlayWindow: false,
            isTauriDesktop: true,
            isTablet: true,
            isTerminalConnectRoute: false,
        })).toBe('none');
    });
});
