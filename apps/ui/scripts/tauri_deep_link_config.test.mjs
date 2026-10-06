import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import releaseRings from '../../../packages/release-runtime/releaseRings.cjs';
const { getReleaseRingCatalogEntry } = releaseRings;

for (const [ring, filename] of [['stable', 'tauri.conf.json'], ['preview', 'tauri.preview.conf.json'], ['publicdev', 'tauri.publicdev.conf.json']]) {
  test(`desktop ${ring} registers its channel's pairing scheme`, async () => {
    const config = JSON.parse(await readFile(new URL(`../src-tauri/${filename}`, import.meta.url), 'utf8'));
    assert.deepEqual(config.plugins?.['deep-link']?.desktop?.schemes, [getReleaseRingCatalogEntry(ring).appScheme]);
  });
}
