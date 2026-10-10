import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PLUGIN_MANIFEST } from './manifest.js';

describe('brand mark', () => {
  it('declares its packaged brand mark through the generic brand Resource', () => {
    expect(PLUGIN_MANIFEST.brand).toEqual({ iconResourceId: 'brand-icon', monochrome: true });
    expect(PLUGIN_MANIFEST.contributes.resources).toEqual([{ id: 'brand-icon', kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' }]);
    const asset = readFileSync(new URL('../assets/brand.png', import.meta.url));
    expect([...asset.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(asset.readUInt32BE(16)).toBe(asset.readUInt32BE(20));
  });
});
