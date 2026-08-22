import { describe, expect, it, vi } from 'vitest';

describe('layout.maxWidth (web)', () => {
    it('caps main content and headers to the compact preference regardless of viewport size', async () => {
        vi.resetModules();

        vi.doMock('react-native', () => ({
            Dimensions: {
                get: () => ({ width: 2400, height: 1400 }),
            },
            Platform: { OS: 'web' },
        }));

        vi.doMock('@/utils/platform/platform', () => ({ isRunningOnMac: () => false }));
        vi.doMock('@/utils/platform/desktopHost', () => ({ isDesktopHost: () => false }));
        vi.doMock('@/sync/domains/state/storageStore', () => ({
            getStorage: () => ({ getState: () => ({ localSettings: { uiContentWidthMode: 'compact' } }) }),
        }));

        const { layout } = await import('@/components/ui/layout/layout');

        expect(layout.maxWidth).toBe(850);
        expect(layout.headerMaxWidth).toBe(850);
    });

    it('uses the compact content width preference in Tauri desktop', async () => {
        vi.resetModules();

        vi.doMock('react-native', () => ({
            Dimensions: {
                get: () => ({ width: 2400, height: 1400 }),
            },
            Platform: { OS: 'web' },
        }));

        vi.doMock('@/utils/platform/platform', () => ({ isRunningOnMac: () => false }));
        vi.doMock('@/utils/platform/desktopHost', () => ({ isDesktopHost: () => true }));
        vi.doMock('@/sync/domains/state/storageStore', () => ({
            getStorage: () => ({ getState: () => ({ localSettings: { uiContentWidthMode: 'compact' } }) }),
        }));

        const { layout } = await import('@/components/ui/layout/layout');

        expect(layout.maxWidth).toBe(850);
        expect(layout.headerMaxWidth).toBe(850);
    });

    it('uses the medium content width preference', async () => {
        vi.resetModules();

        vi.doMock('react-native', () => ({
            Dimensions: {
                get: () => ({ width: 2400, height: 1400 }),
            },
            Platform: { OS: 'web' },
        }));

        vi.doMock('@/utils/platform/platform', () => ({ isRunningOnMac: () => false }));
        vi.doMock('@/utils/platform/desktopHost', () => ({ isDesktopHost: () => false }));
        vi.doMock('@/sync/domains/state/storageStore', () => ({
            getStorage: () => ({ getState: () => ({ localSettings: { uiContentWidthMode: 'medium' } }) }),
        }));

        const { layout } = await import('@/components/ui/layout/layout');
        const { CONSTRAINED_MAX_WIDTH_PX_BY_VIEWPORT_CLASS } = await import('@/utils/platform/viewportClass');

        expect(layout.maxWidth).toBe(CONSTRAINED_MAX_WIDTH_PX_BY_VIEWPORT_CLASS.medium);
    });

    it('removes the content width cap for the full-width preference', async () => {
        vi.resetModules();

        vi.doMock('react-native', () => ({
            Dimensions: {
                get: () => ({ width: 2400, height: 1400 }),
            },
            Platform: { OS: 'web' },
        }));

        vi.doMock('@/utils/platform/platform', () => ({ isRunningOnMac: () => false }));
        vi.doMock('@/utils/platform/desktopHost', () => ({ isDesktopHost: () => false }));
        vi.doMock('@/sync/domains/state/storageStore', () => ({
            getStorage: () => ({ getState: () => ({ localSettings: { uiContentWidthMode: 'full' } }) }),
        }));

        const { layout } = await import('@/components/ui/layout/layout');

        expect(layout.maxWidth).toBe(Number.POSITIVE_INFINITY);
    });
});
