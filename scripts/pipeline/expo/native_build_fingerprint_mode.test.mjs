import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

function readRepoFile(relPath) {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..', '..', '..');
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
}

test('native-build supports fingerprint-gated builds (if-changed)', () => {
  const src = readRepoFile('scripts/pipeline/expo/native-build.mjs');

  // CLI surface
  assert.match(src, /fingerprint-mode/, 'expected native-build.mjs to accept a fingerprint mode flag');

  // Uses EAS to compute the current fingerprint and compare against previous finished builds.
  assert.match(src, /fingerprint:generate/, "expected native-build.mjs to invoke 'eas fingerprint:generate'");
  assert.match(src, /build:list/, "expected native-build.mjs to invoke 'eas build:list'");
  assert.match(src, /--status[\s\S]*finished/, "expected native-build.mjs to filter previous builds by status 'finished'");
});

