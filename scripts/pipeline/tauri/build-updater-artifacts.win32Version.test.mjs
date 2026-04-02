import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeTauriBuildVersionForWindows } from './build-updater-artifacts.mjs';

test('normalizeTauriBuildVersionForWindows strips non-numeric prerelease identifiers (dev)', () => {
  assert.equal(normalizeTauriBuildVersionForWindows('0.1.2-dev.22'), '0.1.2-22');
});

test('normalizeTauriBuildVersionForWindows strips non-numeric prerelease identifiers (preview)', () => {
  assert.equal(normalizeTauriBuildVersionForWindows('0.1.2-preview.123'), '0.1.2-123');
});

test('normalizeTauriBuildVersionForWindows preserves production semver', () => {
  assert.equal(normalizeTauriBuildVersionForWindows('0.1.2'), '0.1.2');
});

test('normalizeTauriBuildVersionForWindows clamps too-large numeric prereleases', () => {
  assert.equal(normalizeTauriBuildVersionForWindows('0.1.2-dev.999999'), '0.1.2-65535');
});

