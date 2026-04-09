import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const setRootViewBackgroundColorMock = vi.fn();
const setBackgroundColorAsyncMock = vi.fn(async () => {});
const loadThemePreferenceMock = vi.fn(() => 'light');
const windowStub = {
    location: {
        href: 'http://localhost/',
        pathname: '/',
    },
} as unknown as Window & { location: { href: string; pathname: string } };

vi.mock('expo-system-ui', () => ({
    setBackgroundColorAsync: setBackgroundColorAsyncMock,
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        runtime: {
            setRootViewBackgroundColor: setRootViewBackgroundColorMock,
        },
    });
});

vi.mock('./sync/domains/state/persistence', () => ({
    loadThemePreference: () => loadThemePreferenceMock(),
}));

describe('unistyles overlay background bootstrap', () => {
    beforeEach(() => {
        vi.stubGlobal('window', windowStub);
        setRootViewBackgroundColorMock.mockReset();
        setBackgroundColorAsyncMock.mockReset();
        loadThemePreferenceMock.mockReset();
        loadThemePreferenceMock.mockReturnValue('light');
        windowStub.location.href = 'http://localhost/';
        windowStub.location.pathname = '/';
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('keeps the overlay window root background transparent instead of applying the theme surface color', async () => {
        windowStub.location.href = 'http://localhost/desktop/activity-overlay?desktopOverlayWindow=1';
        windowStub.location.pathname = '/desktop/activity-overlay';

        await import('./unistyles');

        expect(setRootViewBackgroundColorMock).toHaveBeenCalledWith('transparent');
        expect(setBackgroundColorAsyncMock).not.toHaveBeenCalled();
    });
});
