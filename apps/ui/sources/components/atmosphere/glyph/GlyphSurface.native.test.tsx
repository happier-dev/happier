import * as React from 'react';
import { expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { GlyphSurface, warmGlyphSurface } from './GlyphSurface.native';

const presented = vi.hoisted(() => vi.fn());

vi.mock('./glyphAtlas.native', async () => ({
    glyphAtlas: (await import('@/dev/testkit/mocks/reactNativeSkia')).createGlyphAtlasRasterMock,
}));

vi.mock('@shopify/react-native-skia', async () => {
    const skia = (await import('@/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaGlyphMock();
    return {
        ...skia,
        Picture({ picture }: { picture: { value: unknown } }) {
            // The Skia recorder materializes the current shared value at mount.
            if (picture.value == null) throw new Error('Skia requires a picture on mount');
            presented(picture.value);
            return null;
        },
    };
});

it('presents the first recorded native glyph frame without mounting an empty picture value', async () => {
    const painted = vi.fn();
    const screen = await renderScreen(<GlyphSurface width={48} height={32} scene={[]} onPaint={painted} />);
    try {
        await vi.waitFor(() => expect(painted).toHaveBeenCalledOnce());
        expect(presented).toHaveBeenCalledOnce();
    } finally {
        await screen.unmount();
    }
});

it('publishes a drawn native frame by the first layout when admission has time to warm', async () => {
    const warmup = warmGlyphSurface();
    await vi.dynamicImportSettled();

    let readiness: string | null = null;
    const firstLayout = vi.fn();
    function Destination() {
        React.useLayoutEffect(() => firstLayout(readiness), []);
        return null;
    }
    const screen = await renderScreen(<>
        <GlyphSurface width={48} height={32} scene={[]} warmWhenHidden warmup={warmup}
            onReady={status => { readiness = status; }} />
        <Destination />
    </>);
    try {
        expect(firstLayout).toHaveBeenCalledExactlyOnceWith('ready');
    } finally {
        await screen.unmount();
    }
});
