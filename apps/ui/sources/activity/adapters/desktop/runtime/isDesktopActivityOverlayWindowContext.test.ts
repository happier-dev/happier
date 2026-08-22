import { afterEach, describe, expect, it, vi } from 'vitest';

const isDesktopHostMock = vi.hoisted(() => vi.fn(() => false));

vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => isDesktopHostMock(),
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
        isDesktopHostMock.mockReset();
        delete (globalThis as any).window;
    });

    it('returns false when not running in tauri desktop', async () => {
        isDesktopHostMock.mockReturnValue(false);
        const { isDesktopActivityOverlayWindowContext } = await import('./isDesktopActivityOverlayWindowContext');

        expect(isDesktopActivityOverlayWindowContext()).toBe(false);
    });

    it('returns true for tauri overlay window marker query parameter', async () => {
        isDesktopHostMock.mockReturnValue(true);
        setWindowLocation('http://localhost:8081/desktop/activity-overlay?desktopOverlayWindow=1');
        const { isDesktopActivityOverlayWindowContext } = await import('./isDesktopActivityOverlayWindowContext');

        expect(isDesktopActivityOverlayWindowContext()).toBe(true);
    });

    it('returns true for the overlay route path even when the marker query parameter is missing', async () => {
        isDesktopHostMock.mockReturnValue(true);
        setWindowLocation('http://localhost:8081/desktop/activity-overlay');
        const { isDesktopActivityOverlayWindowContext } = await import('./isDesktopActivityOverlayWindowContext');

        expect(isDesktopActivityOverlayWindowContext()).toBe(true);
    });

    it('returns false when marker query parameter appears on a non-overlay route', async () => {
        isDesktopHostMock.mockReturnValue(true);
        setWindowLocation('http://localhost:8081/settings?desktopOverlayWindow=1');
        const { isDesktopActivityOverlayWindowContext } = await import('./isDesktopActivityOverlayWindowContext');

        expect(isDesktopActivityOverlayWindowContext()).toBe(false);
    });
});
