import { expect, it, vi } from 'vitest';
import { fieldDotLayer, glyphFrame, planetGlyphLayer } from '@happier-dev/brand/glyph-scene';
import { horizonPlanetGeometry } from '@happier-dev/brand/planet-placement';

import { createNativeGlyphPainter } from './glyphPainter.native';

const native = vi.hoisted(() => ({
    transformAllocations: 0,
    images: 0,
    atlasDraws: 0,
    sprites: [] as [number, number, number, number][],
}));

vi.mock('@shopify/react-native-skia', async () => {
    const { createReactNativeSkiaGlyphMock } = await import('@/dev/testkit/mocks/reactNativeSkia');
    return createReactNativeSkiaGlyphMock({
        onTransform: () => { native.transformAllocations++; },
        onImage: () => { native.images++; },
        onAtlas: (sources, transforms, colours) => {
            expect(sources).toHaveLength(transforms.length);
            expect(colours).toHaveLength(transforms.length);
            native.atlasDraws++;
            for (let i = 0; i < transforms.length; i++) {
                native.sprites.push([sources[i].x, transforms[i].x, transforms[i].y, Math.round(colours[i][3] * 255)]);
            }
        },
    });
});

vi.mock('./glyphAtlas.native', async () => {
    const { createGlyphAtlasRasterMock } = await import('@/dev/testkit/mocks/reactNativeSkia');
    return { glyphAtlas: createGlyphAtlasRasterMock };
});

it('streams all field and planet glyphs in painter order using transforms reserved before a frame', async () => {
    const width = 390;
    const height = 600;
    const frame = glyphFrame({ view: { w: width, h: height }, dpr: 1, theme: 'light', layers: [
        fieldDotLayer({ mode: 'still' }),
        planetGlyphLayer({ geometry: horizonPlanetGeometry({ width, height }, { phone: true, composerTop: 260 }),
            intensity: 'quiet', digits: true, fade: { from: 400, to: 560 } }),
    ] });
    const painter = await createNativeGlyphPainter(frame.grid, 1);
    try {
        painter.reserveSpriteBatch(width, height);
        const initialAllocations = native.transformAllocations;
        const [w, h] = frame.grid.cell;
        const batches = [frame.field!.sprites, frame.sprites];
        const slots = frame.grid.cols * frame.grid.rows;
        expect(initialAllocations).toBe(slots);
        expect(batches[0].glyph.length).toBeGreaterThan(slots);
        expect(batches[1].glyph.length).toBeGreaterThan(slots);
        painter.paint(frame).dispose();
        expect(native.transformAllocations - initialAllocations).toBe(0);
        expect(native.sprites).toEqual(batches.flatMap(({ at, glyph, rgba }) => Array.from(glyph, (tile, i) => [
            tile * w, at[i * 2] - w / 2, at[i * 2 + 1] - h / 2, rgba[i * 4 + 3],
        ])));
        expect(native.atlasDraws).toBe(batches.reduce((draws, batch) => draws + Math.ceil(batch.glyph.length / slots), 0));

        const initializedImages = native.images;
        native.sprites.length = 0;
        painter.paint(frame).dispose();
        expect(native.transformAllocations).toBe(initialAllocations);
        expect(native.images).toBe(initializedImages);
    } finally {
        painter.dispose();
    }
});
