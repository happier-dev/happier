import { describe, expect, it, vi } from 'vitest';

describe('layout.maxWidth (web)', () => {
    it('caps main content to 800px regardless of viewport size (without changing header width)', async () => {
        vi.resetModules();

        vi.doMock('react-native', () => ({
            Dimensions: {
                get: () => ({ width: 2400, height: 1400 }),
            },
            Platform: { OS: 'web' },
        }));

        vi.doMock('@/utils/platform/platform', () => ({ isRunningOnMac: () => false }));
        vi.doMock('@/utils/platform/tauri', () => ({ isTauriDesktop: () => false }));

        const { layout } = await import('@/components/ui/layout/layout');

        expect(layout.maxWidth).toBe(800);
        expect(layout.headerMaxWidth).toBe(1400);
    });

    it('does not change Tauri desktop content width', async () => {
        vi.resetModules();

        vi.doMock('react-native', () => ({
            Dimensions: {
                get: () => ({ width: 2400, height: 1400 }),
            },
            Platform: { OS: 'web' },
        }));

        vi.doMock('@/utils/platform/platform', () => ({ isRunningOnMac: () => false }));
        vi.doMock('@/utils/platform/tauri', () => ({ isTauriDesktop: () => true }));

        const { layout } = await import('@/components/ui/layout/layout');

        expect(layout.maxWidth).toBe(1400);
        expect(layout.headerMaxWidth).toBe(Number.POSITIVE_INFINITY);
    });
});
