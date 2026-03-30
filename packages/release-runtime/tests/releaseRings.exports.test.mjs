import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('release-runtime exposes a prebuilt CommonJS releaseRings entrypoint for config-time consumers', () => {
  const pkgDir = process.cwd();
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));

  assert.equal(pkg?.exports?.['./releaseRings']?.require, './releaseRings.cjs');
  assert.ok(fs.existsSync(path.join(pkgDir, 'releaseRings.cjs')));
});
