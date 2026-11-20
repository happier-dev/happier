import { rename, writeFile } from 'node:fs/promises';
import { createLoadingPlanetScene, glyphFrame, loadingPlanetSize } from '@happier-dev/brand/glyph-scene';

import { renderPublicProfilePlanetSceneSvg } from '@/app/account/profile/render/publicProfileSvg';
import { loadSharp } from '@/storage/blob/sharpRuntime';

// From apps/server: node scripts/runTsx.mjs scripts/generateLaunchPlanetPosters.ts
// HTML, the Expo splash, and the JS loader reuse these two transparent Still frames.
const pane = { width: loadingPlanetSize, height: loadingPlanetSize };
const still = createLoadingPlanetScene()(0);
const sharp = await loadSharp();
for (const theme of ['light', 'dark'] as const) {
    const frame = glyphFrame({ view: { w: pane.width, h: pane.height }, theme, layers: still, dpr: 2 });
    const ink = await renderPublicProfilePlanetSceneSvg(frame, pane, 2);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pane.width}" height="${pane.height}">${ink}</svg>`;
    const png = await sharp(Buffer.from(svg), { density: 144 }).png().toBuffer();
    const output = new URL(`../../ui/public/launch-planet-${theme}.png`, import.meta.url);
    const pending = new URL(`${output.href}.${process.pid}.tmp`);
    await writeFile(pending, png);
    await rename(pending, output);
}
