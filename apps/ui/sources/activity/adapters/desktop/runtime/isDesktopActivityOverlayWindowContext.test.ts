import { afterEach, describe, expect, it, vi } from 'vitest';

const isTauriDesktopMock = vi.hoisted(() => vi.fn(() => false));

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => isTauriDesktopMock(),
}));

function setWindowLocation(url: string) {
    Object.defineProperty(globalThis, 'window', {
        value: {
            location: {
                href: url,
            },
        },
        configurable: true,
        writable: true,
    });
}

describe('isDesktopActivityOverlayWindowContext', () => {
    afterEach(() => {
        isTauriDesktopMock.mockReset();
        delete (globalThis as any).window;
    });

    it('returns false when not running in tauri desktop', async () => {
        isTauriDesktopMock.mockReturnValue(false);
        const { isDesktopActivityOverlayWindowContext } = await import('./isDesktopActivityOverlayWindowContext');

        expect(isDesktopActivityOverlayWindowContext()).toBe(false);
    });

    it('returns true for tauri overlay window marker query parameter', async () => {
        isTauriDesktopMock.mockReturnValue(true);
        setWindowLocation('http://localhost:8081/desktop/activity-overlay?desktopOverlayWindow=1');
        const { isDesktopActivityOverlayWindowContext } = await import('./isDesktopActivityOverlayWindowContext');

        expect(isDesktopActivityOverlayWindowContext()).toBe(true);
    });

    it('returns true for the overlay route path even when the marker query parameter is missing', async () => {
        isTauriDesktopMock.mockReturnValue(true);
        setWindowLocation('http://localhost:8081/desktop/activity-overlay');
        const { isDesktopActivityOverlayWindowContext } = await import('./isDesktopActivityOverlayWindowContext');

        expect(isDesktopActivityOverlayWindowContext()).toBe(true);
    });

    it('returns false when marker query parameter appears on a non-overlay route', async () => {
        isTauriDesktopMock.mockReturnValue(true);
        setWindowLocation('http://localhost:8081/settings?desktopOverlayWindow=1');
        const { isDesktopActivityOverlayWindowContext } = await import('./isDesktopActivityOverlayWindowContext');

        expect(isDesktopActivityOverlayWindowContext()).toBe(false);
    });
});
