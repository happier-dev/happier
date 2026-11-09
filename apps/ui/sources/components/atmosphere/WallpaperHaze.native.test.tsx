import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { BackdropRenderRequest } from './backdropCanvas.types';
import type { PictureRecord } from './pictureStore.types';
import { WALLPAPER_HAZE_LAYERS } from './wallpaperHaze';
import { WallpaperHaze } from './WallpaperHaze.native';

const boundary = vi.hoisted(() => ({ backdrops: [] as BackdropRenderRequest[], hazes: [] as { width: number; height: number }[] }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
// The secondary raster runtime and native image handles are unavailable in the host test.
vi.mock('./renderBackdrop.native', () => ({
    NATIVE_TONE_SIDE: 16,
    acquireNativeBackdrop: (request: BackdropRenderRequest) => { boundary.backdrops.push(request); return { promise: Promise.resolve(`native:${request.width}x${request.height}`), release() {} }; },
    renderNativeWallpaperHaze: async (_source: unknown, size: { width: number; height: number }) => { boundary.hazes.push(size); return { dispose() {} }; },
    readNativePicturePixels: vi.fn(),
}));

beforeEach(() => { boundary.backdrops.length = 0; boundary.hazes.length = 0; vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

it('renders one settled resize instead of rasterizing every native resize arrival', async () => {
    const source: PictureRecord = { localId: 'cached', kind: 'builtin', data: 'cached', size: 1, createdAtMs: 1 };
    const props = { source, size: { width: 800, height: 600 }, focus: { x: 0.5, y: 0.5 },
        haze: { layers: WALLPAPER_HAZE_LAYERS, veil: null, ink: 'theme' as const },
        job: { look: 'original', theme: 'light', page: [245, 245, 245] },
    } satisfies React.ComponentProps<typeof WallpaperHaze>;
    const screen = await renderScreen(<WallpaperHaze {...props} />);
    boundary.backdrops.length = 0; boundary.hazes.length = 0;
    for (let offset = 1; offset <= 100; offset++) {
        await screen.update(<WallpaperHaze {...props} size={{ width: 800 + offset, height: 600 }} focus={{ x: 0.5 + offset / 1000, y: 0.5 }} />);
    }
    expect(boundary.backdrops).toHaveLength(0);
    expect(boundary.hazes).toHaveLength(0);
    await act(async () => { vi.advanceTimersByTime(120); });
    expect(boundary.backdrops).toHaveLength(1);
    expect(boundary.backdrops[0]?.width).toBe(225);
    expect(boundary.hazes.length).toBeGreaterThan(0);
    expect(boundary.hazes.length).toBeLessThanOrEqual(2);
    expect(boundary.hazes.every(size => size.width === 900 && size.height === 600)).toBe(true);
    await screen.unmount();
    expect(vi.getTimerCount()).toBe(0);
});
