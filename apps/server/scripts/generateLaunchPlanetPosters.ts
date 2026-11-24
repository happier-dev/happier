import { rename, writeFile } from 'node:fs/promises';
import { loadingPlanetSize } from '@happier-dev/brand/glyph-scene';

import { loadSharp } from '@/storage/blob/sharpRuntime';

// The launch posters are the live planet's own first frame, so the HTML shell, the Expo splash and the
// launch curtain's Still frame hand over to the live planet without a step. Capture the web painter's
// frame at 2× in a browser (`/dev/glyphs?moment=launch&theme=<theme>`, the surface element) once over a
// black page and once over a white page, then, from apps/server:
//   node scripts/runTsx.mjs scripts/generateLaunchPlanetPosters.ts \
//     <light-on-black.png> <light-on-white.png> <dark-on-black.png> <dark-on-white.png>
// Each pair recovers the frame's exact colour and coverage as one transparent poster.
const captures = process.argv.slice(2);
if (captures.length !== 4) throw new Error('Pass the light and dark captures, each over black then over white.');
const sharp = await loadSharp();
const side = loadingPlanetSize * 2;
const pixels = async (path: string) => (await sharp(path).resize(side, side, { fit: 'fill' }).removeAlpha().raw()
    .toBuffer({ resolveWithObject: true })).data;
for (const [index, theme] of (['light', 'dark'] as const).entries()) {
    const [overBlack, overWhite] = await Promise.all([pixels(captures[index * 2]!), pixels(captures[index * 2 + 1]!)]);
    const rgba = Buffer.alloc(side * side * 4);
    for (let n = 0; n < side * side; n++) {
        // Over black a pixel is c·a; over white it is c·a + 255·(1 − a).
        let spread = 0;
        for (let c = 0; c < 3; c++) spread += overWhite[n * 3 + c]! - overBlack[n * 3 + c]!;
        const alpha = Math.min(1, Math.max(0, 1 - spread / 3 / 255));
        for (let c = 0; c < 3; c++) {
            rgba[n * 4 + c] = alpha > 0 ? Math.min(255, Math.round(overBlack[n * 3 + c]! / alpha)) : 0;
        }
        rgba[n * 4 + 3] = Math.round(alpha * 255);
    }
    const png = await sharp(rgba, { raw: { width: side, height: side, channels: 4 } }).png().toBuffer();
    const output = new URL(`../../ui/public/launch-planet-${theme}.png`, import.meta.url);
    const pending = new URL(`${output.href}.${process.pid}.tmp`);
    await writeFile(pending, png);
    await rename(pending, output);
}
