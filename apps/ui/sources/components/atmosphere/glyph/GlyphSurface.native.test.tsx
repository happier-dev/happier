import * as React from 'react';
import { expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { GlyphSurface } from './GlyphSurface.native';

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
