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

describe('isDesktopPetOverlayWindowContext', () => {
    afterEach(() => {
        isTauriDesktopMock.mockReset();
        delete (globalThis as Partial<{ window: unknown }>).window;
    });

    it('returns false outside Tauri desktop', async () => {
        isTauriDesktopMock.mockReturnValue(false);
        setWindowLocation('http://localhost:8081/desktop/pet-overlay?desktopPetOverlayWindow=1');
        const { isDesktopPetOverlayWindowContext } = await import('./isDesktopPetOverlayWindowContext');

        expect(isDesktopPetOverlayWindowContext()).toBe(false);
    });

    it('returns true for the dedicated pet overlay route', async () => {
        isTauriDesktopMock.mockReturnValue(true);
        setWindowLocation('http://localhost:8081/desktop/pet-overlay?desktopPetOverlayWindow=1');
        const { isDesktopPetOverlayWindowContext } = await import('./isDesktopPetOverlayWindowContext');

        expect(isDesktopPetOverlayWindowContext()).toBe(true);
    });

    it('returns true when the overlay route loses its marker query parameter', async () => {
        isTauriDesktopMock.mockReturnValue(true);
        setWindowLocation('http://localhost:8081/desktop/pet-overlay');
        const { isDesktopPetOverlayWindowContext } = await import('./isDesktopPetOverlayWindowContext');

        expect(isDesktopPetOverlayWindowContext()).toBe(true);
    });

    it('returns false when the marker query parameter appears on the main window route', async () => {
        isTauriDesktopMock.mockReturnValue(true);
        setWindowLocation('http://localhost:8081/settings/pets?desktopPetOverlayWindow=1');
        const { isDesktopPetOverlayWindowContext } = await import('./isDesktopPetOverlayWindowContext');

        expect(isDesktopPetOverlayWindowContext()).toBe(false);
    });
});
