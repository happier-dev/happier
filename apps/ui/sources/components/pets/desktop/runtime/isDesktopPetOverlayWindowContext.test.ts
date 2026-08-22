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

describe('isDesktopPetOverlayWindowContext', () => {
    afterEach(() => {
        isDesktopHostMock.mockReset();
        delete (globalThis as Partial<{ window: unknown }>).window;
    });

    it('returns false outside Tauri desktop', async () => {
        isDesktopHostMock.mockReturnValue(false);
        setWindowLocation('http://localhost:8081/desktop/pet-overlay?desktopPetOverlayWindow=1');
        const { isDesktopPetOverlayWindowContext } = await import('./isDesktopPetOverlayWindowContext');

        expect(isDesktopPetOverlayWindowContext()).toBe(false);
    });

    it('returns true for the dedicated pet overlay route', async () => {
        isDesktopHostMock.mockReturnValue(true);
        setWindowLocation('http://localhost:8081/desktop/pet-overlay?desktopPetOverlayWindow=1');
        const { isDesktopPetOverlayWindowContext } = await import('./isDesktopPetOverlayWindowContext');

        expect(isDesktopPetOverlayWindowContext()).toBe(true);
    });

    it('returns true when the overlay route loses its marker query parameter', async () => {
        isDesktopHostMock.mockReturnValue(true);
        setWindowLocation('http://localhost:8081/desktop/pet-overlay');
        const { isDesktopPetOverlayWindowContext } = await import('./isDesktopPetOverlayWindowContext');

        expect(isDesktopPetOverlayWindowContext()).toBe(true);
    });

    it('returns false when the marker query parameter appears on the main window route', async () => {
        isDesktopHostMock.mockReturnValue(true);
        setWindowLocation('http://localhost:8081/settings/pets?desktopPetOverlayWindow=1');
        const { isDesktopPetOverlayWindowContext } = await import('./isDesktopPetOverlayWindowContext');

        expect(isDesktopPetOverlayWindowContext()).toBe(false);
    });
});
