import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const releasePackagesPath = fileURLToPath(new URL('./release-packages.mjs', import.meta.url));

test('public SDK release packing schedules one exact-tarball validation phase before publication', () => {
  const version = '0.1.0-preview.777';
  const result = spawnSync(process.execPath, [
    releasePackagesPath,
    '--channel', 'preview',
    '--publish-plugin-sdk', 'true',
    '--publish-sdk', 'true',
    '--plugin-sdk-version', version,
    '--sdk-version', version,
    '--mode', 'pack+publish',
    '--dry-run',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const validationMatch = new RegExp(
    `validate-public-sdk-tarballs\\.mjs --plugin-sdk-tarball .*plugin_sdk-${version}\\.tgz --plugin-ui-tarball .*plugin_ui-${version}\\.tgz --sdk-tarball .*sdk-${version}\\.tgz`,
    'u',
  );
  assert.match(result.stdout, validationMatch);
  const validationIndex = result.stdout.search(validationMatch);
  const firstPublishIndex = result.stdout.indexOf('publish-tarball.mjs');
  assert.ok(validationIndex >= 0);
  assert.ok(firstPublishIndex > validationIndex, 'publication must follow exact-tarball validation');
});
