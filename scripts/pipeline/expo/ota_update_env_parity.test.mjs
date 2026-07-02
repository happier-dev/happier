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

test('ota-update merges EAS build profile env so fingerprint-based runtimeVersion matches native builds', () => {
  const src = readRepoFile('scripts/pipeline/expo/ota-update.mjs');

  assert.match(
    src,
    /resolveEasBuildProfileEnv/,
    'expected ota-update.mjs to resolve and merge EAS build profile env for runtimeVersion parity',
  );

  assert.match(src, /\.\.\.easProfileEnv/, 'expected ota-update.mjs to spread easProfileEnv into the EAS command env');
});

test('ota-update routes fingerprint JSON through the shared noisy-output parser', () => {
  const src = readRepoFile('scripts/pipeline/expo/ota-update.mjs');

  assert.match(
    src,
    /parseJsonFromCommandOutput/,
    'expected ota-update.mjs to use the shared JSON-output parser for eas fingerprint:generate output',
  );
  assert.doesNotMatch(
    src,
    /const parsed = JSON\.parse\(fpJson\);/,
    'expected ota-update.mjs to avoid raw JSON.parse(fpJson) for fingerprint output',
  );
});
