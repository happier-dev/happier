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

test('ui-mobile OTA forwards platform and splits all-platform fingerprint runtimes', () => {
  const runSrc = readRepoFile('scripts/pipeline/run.mjs');
  const otaSrc = readRepoFile('scripts/pipeline/expo/ota-update.mjs');

  assert.match(runSrc, /subcommand === 'expo-ota'[\s\S]*platform:\s*\{\s*type:\s*'string'/);
  assert.match(runSrc, /runExpoOtaUpdate[\s\S]*'--platform'[\s\S]*platform/);
  assert.match(runSrc, /const otaPlatforms = platform === 'all' \? \['android', 'ios'\] : \[platform\]/);
  assert.match(runSrc, /runtimeVersion && platform === 'all'/);
  assert.match(runSrc, /if \(action === 'ota'\)[\s\S]*const otaPlatforms = platform === 'all' \? \['android', 'ios'\] : \[platform\]/);
  assert.match(runSrc, /if \(action === 'ota'\)[\s\S]*'--platform'[\s\S]*otaPlatform/);

  assert.match(otaSrc, /platform:\s*\{\s*type:\s*'string'/);
  assert.match(otaSrc, /fingerprint:generate[\s\S]*'--platform'[\s\S]*platform[\s\S]*'--build-profile'/);
  assert.match(otaSrc, /HAPPIER_EXPO_RUNTIME_VERSION\s*=/);
  assert.match(otaSrc, /'update'[\s\S]*'--channel'[\s\S]*updateLane[\s\S]*'--platform'[\s\S]*platform/);
});
