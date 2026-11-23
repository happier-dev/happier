// @happier-test-preparation source
import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { publishDependencyRefreshMarker, resolveDependencyRefreshMarkerPath } from '../../apps/stack/scripts/utils/proc/dependency_refresh.mjs';
import { createTempFixture } from '../../apps/stack/scripts/testkit/core/temp_fixture.mjs';
import { mountInstalledNodeModules } from './buildInputConvergence.mjs';

test('captured modules replace a blocking file and do not adopt the installed tree readiness record', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-capture-modules-file-' });
  const sourceDir = fixture.path('source');
  const captureDir = fixture.path('capture');
  const sourceModules = join(sourceDir, 'node_modules');
  const targetModules = join(captureDir, 'node_modules');
  await mkdir(join(sourceModules, 'color'), { recursive: true });
  await writeFile(join(sourceModules, 'color', 'index.js'), 'installed color');
  await publishDependencyRefreshMarker({ installDir: sourceDir, identity: 'source-install' });
  await mkdir(targetModules, { recursive: true });
  await writeFile(join(targetModules, 'color'), 'blocking file');

  await mountInstalledNodeModules({ sourceModules, targetModules });

  assert.equal(await readFile(join(targetModules, 'color', 'index.js'), 'utf8'), 'installed color');
  assert.equal(await realpath(join(targetModules, 'color')), await realpath(join(sourceModules, 'color')));
  await assert.rejects(lstat(resolveDependencyRefreshMarkerPath(captureDir)), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(resolveDependencyRefreshMarkerPath(sourceDir), 'utf8')).identity, 'source-install');
});
