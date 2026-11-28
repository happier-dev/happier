import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const srcTauriDir = path.join(repoRoot, 'apps', 'ui', 'src-tauri');
const sharp = createRequire(path.join(repoRoot, 'package.json'))('sharp');

// macOS draws a bundled app icon as an 824-point tile centered in a 1024-point cell. The running
// app's Dock image (`NSApplication.applicationIconImage`) is drawn into the whole cell as-is, so
// its artwork has to carry that padding itself or it reads larger than every other Dock icon.
const MACOS_ICON_TILE_FRACTION = 824 / 1024;

async function readEmbeddedDockIconPath() {
  const source = await readFile(path.join(srcTauriDir, 'src', 'app_icon.rs'), 'utf8');
  const match = source.match(/DEFAULT_ICON_ID => include_bytes!\("([^"]+)"\)/u);
  assert.ok(match, 'app_icon.rs should embed the default Dock PNG with include_bytes!');
  return path.join(srcTauriDir, 'src', match[1]);
}

/** Bounds of the pixels that are part of the tile itself, not its soft shadow. */
function solidBounds({ data, info }) {
  let left = info.width;
  let top = info.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (data[(y * info.width + x) * 4 + 3] >= 200) {
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
  }
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

test('the running-app Dock icon sits in the macOS icon grid, not full bleed', async () => {
  const raster = await sharp(await readEmbeddedDockIconPath()).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(raster.info.width, raster.info.height, 'the Dock image should be square');

  const cell = raster.info.width;
  const bounds = solidBounds(raster);
  const expected = cell * MACOS_ICON_TILE_FRACTION;
  const tolerance = cell / 256;

  assert.ok(Math.abs(bounds.width - expected) <= tolerance, `tile width ${bounds.width}px, expected ≈${expected}px of ${cell}px`);
  assert.ok(Math.abs(bounds.height - expected) <= tolerance, `tile height ${bounds.height}px, expected ≈${expected}px of ${cell}px`);
  const margin = (cell - expected) / 2;
  assert.ok(Math.abs(bounds.left - margin) <= tolerance, `tile left edge ${bounds.left}px, expected ≈${margin}px`);
  assert.ok(Math.abs(bounds.top - margin) <= tolerance, `tile top edge ${bounds.top}px, expected ≈${margin}px`);
});
