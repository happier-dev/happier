import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('release UI web bundle export enables Expo Router web modal support', () => {
  const script = fs.readFileSync(
    path.join(repoRoot, 'scripts', 'pipeline', 'release', 'build-ui-web-bundle.mjs'),
    'utf8',
  );

  assert.match(script, /EXPO_UNSTABLE_WEB_MODAL:\s*'1'/);
});
