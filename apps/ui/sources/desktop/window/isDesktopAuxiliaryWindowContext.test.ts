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

describe('isDesktopAuxiliaryWindowContext', () => {
    afterEach(() => {
        isDesktopHostMock.mockReset();
        delete (globalThis as Partial<{ window: unknown }>).window;
    });

    it.each([
        '/desktop/activity-overlay',
        '/desktop/pet-overlay',
        '/desktop/capture',
        '/desktop/capture-selection',
    ])('recognizes the dedicated %s presenter route', async (pathname) => {
        isDesktopHostMock.mockReturnValue(true);
        setWindowLocation(`http://localhost:8081${pathname}`);
        const { isDesktopAuxiliaryWindowContext } = await import('./isDesktopAuxiliaryWindowContext');

        expect(isDesktopAuxiliaryWindowContext()).toBe(true);
    });

    it.each([
        ['/desktop/window', 'destination'],
        ['/desktop/app-window', 'full'],
    ] as const)('gives %s ordinary secondary data with its own chrome', async (pathname, chrome) => {
        isDesktopHostMock.mockReturnValue(true);
        setWindowLocation(`http://localhost:8081${pathname}/`);
        const owner = await import('./isDesktopAuxiliaryWindowContext');
        expect(owner.resolveDesktopWindowContext()).toEqual({ role: 'secondary', chrome });
        expect(owner.isDesktopAuxiliaryWindowContext()).toBe(false);
    });

    it('keeps a presenter projection-only and ordinary/browser routes primary', async () => {
        const owner = await import('./isDesktopAuxiliaryWindowContext');
        isDesktopHostMock.mockReturnValue(true);
        setWindowLocation('http://localhost:8081/desktop/capture');
        expect(owner.resolveDesktopWindowContext()).toEqual({ role: 'presenter', chrome: 'destination' });
        setWindowLocation('http://localhost:8081/session/one');
        expect(owner.resolveDesktopWindowContext()).toEqual({ role: 'primary', chrome: 'full' });
        isDesktopHostMock.mockReturnValue(false);
        setWindowLocation('http://localhost:8081/desktop/window');
        expect(owner.resolveDesktopWindowContext()).toEqual({ role: 'primary', chrome: 'full' });
    });

    it('keeps the boot role and result identity after ordinary navigation in a full secondary', async () => {
        isDesktopHostMock.mockReturnValue(true);
        setWindowLocation('http://localhost:8081/desktop/app-window');
        const owner = await import('./isDesktopAuxiliaryWindowContext');
        const boot = owner.resolveDesktopWindowContext();
        window.location.href = 'http://localhost:8081/settings/appearance';
        expect(owner.resolveDesktopWindowContext()).toBe(boot);
        expect(boot).toEqual({ role: 'secondary', chrome: 'full' });
    });

    it('does not classify an ordinary Tauri app route as an overlay', async () => {
        isDesktopHostMock.mockReturnValue(true);
        setWindowLocation('http://localhost:8081/settings/pets');
        const { isDesktopAuxiliaryWindowContext } = await import('./isDesktopAuxiliaryWindowContext');

        expect(isDesktopAuxiliaryWindowContext()).toBe(false);
    });

    it('does not classify a matching route outside Tauri desktop as an overlay', async () => {
        isDesktopHostMock.mockReturnValue(false);
        setWindowLocation('http://localhost:8081/desktop/pet-overlay');
        const { isDesktopAuxiliaryWindowContext } = await import('./isDesktopAuxiliaryWindowContext');

        expect(isDesktopAuxiliaryWindowContext()).toBe(false);
    });
});
