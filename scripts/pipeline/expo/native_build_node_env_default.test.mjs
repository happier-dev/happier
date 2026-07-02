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

test('native-build ensures NODE_ENV is set for EAS build subprocesses (fixes local build failures)', () => {
  const src = readRepoFile('scripts/pipeline/expo/native-build.mjs');

  // EAS local build (and some config plugins) expect NODE_ENV to be set.
  // The pipeline should ensure it is set when launching EAS build commands.
  assert.match(src, /NODE_ENV/, 'expected native-build to set NODE_ENV for EAS builds');
  assert.match(src, /resolveEasBuildProfileEnv/, 'expected native-build to apply the selected EAS build profile env');
  assert.match(src, /APP_ENV/, 'expected native-build to align APP_ENV with the selected build profile');
});

test('native-build includes the Expo web-modal env in host local build subprocesses', () => {
  const src = readRepoFile('scripts/pipeline/expo/native-build.mjs');

  assert.match(
    src,
    /const expoWebModalEnv = \{ EXPO_UNSTABLE_WEB_MODAL: '1' \};[\s\S]*const baseEnv =[\s\S]*\.\.\.expoWebModalEnv[\s\S]*const buildEnvBase = withUtf8LocaleDefaults\(baseEnv\)[\s\S]*createEasLocalBuildEnv\(\{ baseEnv: buildEnvBase, platform \}\)/s,
    'expected native-build to include the shared EXPO_UNSTABLE_WEB_MODAL env in the base env that feeds host local EAS builds',
  );
});
