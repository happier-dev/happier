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

describe('isDesktopOverlayWindowContext', () => {
    afterEach(() => {
        isDesktopHostMock.mockReset();
        delete (globalThis as Partial<{ window: unknown }>).window;
    });

    it.each([
        '/desktop/activity-overlay',
        '/desktop/pet-overlay',
    ])('recognizes the dedicated %s presenter route', async (pathname) => {
        isDesktopHostMock.mockReturnValue(true);
        setWindowLocation(`http://localhost:8081${pathname}`);
        const { isDesktopOverlayWindowContext } = await import('./isDesktopOverlayWindowContext');

        expect(isDesktopOverlayWindowContext()).toBe(true);
    });

    it('does not classify an ordinary Tauri app route as an overlay', async () => {
        isDesktopHostMock.mockReturnValue(true);
        setWindowLocation('http://localhost:8081/settings/pets');
        const { isDesktopOverlayWindowContext } = await import('./isDesktopOverlayWindowContext');

        expect(isDesktopOverlayWindowContext()).toBe(false);
    });

    it('does not classify a matching route outside Tauri desktop as an overlay', async () => {
        isDesktopHostMock.mockReturnValue(false);
        setWindowLocation('http://localhost:8081/desktop/pet-overlay');
        const { isDesktopOverlayWindowContext } = await import('./isDesktopOverlayWindowContext');

        expect(isDesktopOverlayWindowContext()).toBe(false);
    });
});
