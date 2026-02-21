import test from 'node:test';
import assert from 'node:assert/strict';

import { withCurrentVersionLine } from '../pipeline/release/lib/rolling-release-notes.mjs';

test('rolling release notes: appends current version line', () => {
  const out = withCurrentVersionLine('Rolling preview CLI binaries.', '1.2.3-preview.1.2');
  assert.match(out, /Rolling preview CLI binaries\./);
  assert.match(out, /Current version: v1\.2\.3-preview\.1\.2/);
});

test('rolling release notes: does not duplicate current version line', () => {
  const out = withCurrentVersionLine('Rolling.\n\nCurrent version: v1.0.0', '1.0.0');
  assert.equal(out, 'Rolling.\n\nCurrent version: v1.0.0');
});

