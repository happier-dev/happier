import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../..', import.meta.url));

test('Still blits the ordered glyph frame once and keeps field coverage and the planet foot fade', async () => {
    const { outputFiles } = await build({
        absWorkingDir: root,
        stdin: {
            contents: `export { paintWebStill } from './sources/components/atmosphere/glyph/glyphPainter.web';
                export { packGlyphAtlas, glyphAtlasChars, glyphPlanetChars } from './sources/components/atmosphere/glyph/glyphAtlasLayout';
                export { glyphFrame, fieldDotLayer, planetGlyphLayer } from '../../packages/brand/glyph-scene.mjs';
                export { horizonPlanetGeometry } from '../../packages/brand/planet-placement.mjs';`,
            resolveDir: root,
        },
        alias: { 'react-native': 'react-native-web' },
        conditions: ['happier-source'],
        loader: { '.ttf': 'empty' },
        bundle: true,
        write: false,
        format: 'iife',
        globalName: 'glyphs',
    });
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.addScriptTag({ content: outputFiles[0].text });
        const result = await page.evaluate(() => {
            const counts = { arc: 0, fill: 0, putImageData: 0, drawImage: 0, getImageData: 0 };
            let visibleTransfers = 0;
            let target;
            for (const name of Object.keys(counts)) {
                const original = CanvasRenderingContext2D.prototype[name];
                CanvasRenderingContext2D.prototype[name] = function (...args) {
                    counts[name]++;
                    if (this.canvas === target && (name === 'drawImage' || name === 'putImageData')) visibleTransfers++;
                    return original.apply(this, args);
                };
            }
            const atlasFor = (grid) => {
                const [cw, ch] = grid.cell;
                const raster = chars => ({ chars, cw, ch, masks: new Uint8Array(cw * ch * chars.length) });
                const digits = raster(glyphs.glyphAtlasChars);
                digits.masks[1 * cw + 1] = 255;
                return glyphs.packGlyphAtlas(grid, digits, digits, raster(glyphs.glyphPlanetChars), 1);
            };
            function paint(frame) {
                target = document.createElement('canvas');
                target.width = frame.width;
                target.height = frame.height;
                visibleTransfers = 0;
                for (const name of Object.keys(counts)) counts[name] = 0;
                glyphs.paintWebStill(target, frame, atlasFor(frame.grid));
                return { ...counts, visibleTransfers };
            }
            const width = 390;
            const height = 600;
            const large = glyphs.glyphFrame({ view: { w: width, h: height }, dpr: 1, theme: 'light', layers: [
                glyphs.fieldDotLayer({ mode: 'still' }),
                glyphs.planetGlyphLayer({
                    geometry: glyphs.horizonPlanetGeometry({ width, height }, { phone: true, composerTop: 260 }),
                    intensity: 'quiet', digits: true, fade: { from: 400, to: 560 },
                }),
            ] });
            const largeOperations = paint(large);
            const grid = { cell: [4, 4], cols: 6, rows: 4, origin: [0, 0] };
            const sprites = (at, glyph, rgba) => ({ at: Uint16Array.from(at), glyph: Uint8Array.from(glyph), rgba: Uint8Array.from(rgba) });
            const tinyOperations = paint({ width: 24, height: 16, grid,
                field: {
                    sprites: sprites([3, 3, 21, 3], [21, 21], [250, 100, 40, 128, 250, 100, 40, 128]),
                    mask: { width: 2, height: 1, rgba: new Uint8Array([255, 255, 255, 0, 255, 255, 255, 255]) },
                    maskExtent: [24, 16], revision: 1,
                },
                body: {
                    cols: 6, rows: 4, rgba: Uint8Array.from({ length: 6 * 4 * 4 }, (_, i) => [32, 192, 64, 255][i % 4]),
                    disc: { cx: 10, cy: 10, R: 5 },
                    fadeMask: { width: 1, height: 16, rgba: Uint8ClampedArray.from({ length: 16 * 4 }, (_, i) => i < 11 * 4 ? 255 : 0) },
                },
                sprites: sprites([14, 8, 14, 8], [20, 0], [255, 0, 0, 255, 0, 0, 255, 128]),
            });
            const context = target.getContext('2d');
            const pixel = (x, y) => Array.from(context.getImageData(x, y, 1, 1).data);
            return { largeOperations, tinyOperations, fieldCount: large.field.sprites.glyph.length,
                spriteCount: large.sprites.glyph.length, maskedDot: pixel(2, 2), stipple: pixel(20, 2), emptyAtlasTexel: pixel(19, 1),
                outsideDisc: pixel(2, 8), body: pixel(10, 6), fadedFoot: pixel(10, 13),
                orderedOverlay: pixel(13, 7), solidOnly: pixel(14, 7) };
        });
        console.log(JSON.stringify({ fieldCount: result.fieldCount, spriteCount: result.spriteCount, operations: result.largeOperations }));
        assert.ok(result.fieldCount > 6_000 && result.spriteCount > 1_000);
        assert.deepEqual(result.largeOperations, result.tinyOperations);
        assert.equal(result.largeOperations.visibleTransfers, 1);
        assert.equal(result.largeOperations.fill, 0);
        assert.equal(result.largeOperations.getImageData, 0);
        for (const pixel of [result.maskedDot, result.emptyAtlasTexel, result.outsideDisc, result.fadedFoot]) assert.equal(pixel[3], 0);
        assert.ok(result.stipple[3] >= 50 && result.stipple[3] <= 55, JSON.stringify(result.stipple));
        assert.deepEqual(result.body, [32, 192, 64, 255]);
        assert.deepEqual(result.orderedOverlay, [127, 0, 128, 255]);
        assert.deepEqual(result.solidOnly, [255, 0, 0, 255]);
    } finally {
        await browser.close();
    }
});
