import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { TELEGRAM_BRAND_RESOURCE_ID } from './constants.js';
import { PLUGIN_MANIFEST } from './manifest.js';

// Records the selection basis; it does not make the external source or terms immutable.
const TELEGRAM_BRAND_ASSET_PROVENANCE = {
  source: {
    publisher: 'Telegram',
    asset: 'logo (t_logo.svg), rasterized to 288 px',
    url: 'https://telegram.org/img/t_logo.svg',
    svgSha256: '85059d5e5bf7bda91ebab30664993c49867a26be6b947834aca16c846581766a',
  },
  termsUrl: 'https://telegram.org/tour/screenshots',
} as const;

describe('Telegram brand mark', () => {
  // Without a packaged mark the host draws a lettered tile, and marks never sit on tiles.
  it('declares the Telegram logo through the generic Resource owner', () => {
    expect(PLUGIN_MANIFEST.brand).toEqual({ iconResourceId: TELEGRAM_BRAND_RESOURCE_ID });
    expect(PLUGIN_MANIFEST.contributes.resources?.filter(({ id }) => id === TELEGRAM_BRAND_RESOURCE_ID)).toEqual([{
      id: TELEGRAM_BRAND_RESOURCE_ID,
      kind: 'asset',
      path: 'assets/brand.png',
      contentType: 'image/png',
    }]);

    const asset = readFileSync(new URL('../assets/brand.png', import.meta.url));
    expect([...asset.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(asset.readUInt32BE(16)).toBe(288);
    expect(asset.readUInt32BE(20)).toBe(288);
    // RGBA: the logo stands on its own, with transparent corners and no backing square.
    expect(asset[25]).toBe(6);
    expect(createHash('sha256').update(asset).digest('hex')).toMatch(/^[0-9a-f]{64}$/);
    expect(TELEGRAM_BRAND_ASSET_PROVENANCE.source.publisher).toBe('Telegram');
  });
});
