import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

test('release-runtime exposes a prebuilt CommonJS releaseRings entrypoint for config-time consumers', () => {
  const pkgDir = process.cwd();
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  const require = createRequire(import.meta.url);

  assert.equal(pkg?.exports?.['./releaseRings']?.require, './releaseRings.cjs');
  assert.ok(fs.existsSync(path.join(pkgDir, 'releaseRings.cjs')));
  assert.equal(
    pkg?.scripts?.['build:releaseRings:cjs'],
    undefined,
    'release-runtime should ship the checked-in releaseRings.cjs entrypoint instead of compiling a deprecated secondary CJS build'
  );

  const releaseRings = require(path.join(pkgDir, 'releaseRings.cjs'));
  assert.deepEqual(releaseRings.RELEASE_RING_IDS, ['stable', 'preview', 'publicdev', 'internalpreview', 'internaldev']);
  assert.deepEqual(releaseRings.PUBLIC_RELEASE_RING_IDS, ['stable', 'preview', 'publicdev']);
  assert.equal(releaseRings.normalizePublicReleaseRingId('dev'), 'publicdev');
  assert.deepEqual(releaseRings.listPublicReleaseRingLabels(), ['stable', 'preview', 'dev']);
});
