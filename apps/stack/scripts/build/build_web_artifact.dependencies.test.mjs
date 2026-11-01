import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { ensureWebUiDependencies } from './build_web_artifact.mjs';
import { readDependencyPublicationState, withDependencyRefresh } from '../utils/proc/dependency_refresh.mjs';

test('warm web dependency preparation marks its write before postinstall runs', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-web-preparation-writer-' });
  const installer = fixture.path('pnpm.cjs');
  await writeFile(installer, `
    if (process.argv.includes('--version')) console.log('12.14.0');
    else {
      const result = require('node:child_process').spawnSync(process.execPath, ['postinstall.mjs'], { stdio: 'inherit' });
      process.exitCode = result.status;
    }
  `);
  const env = { ...process.env, npm_execpath: installer, HAPPIER_STACK_HOME_DIR: fixture.root,
    HAPPIER_STACK_ENV_FILE: '', HAPPIER_STACK_SKIP_REFRESH_DEPS: '0', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '0' };
  await mkdir(fixture.path('node_modules'));
  await writeFile(fixture.path('package.json'), JSON.stringify({ private: true, name: '@happier-dev/app',
    scripts: { 'postinstall:real': 'node postinstall.mjs' } }));
  await writeFile(fixture.path('postinstall.mjs'), `
    import { mkdir, writeFile } from 'node:fs/promises';
    import { readDependencyPublicationState } from ${JSON.stringify(new URL('../utils/proc/dependency_refresh.mjs', import.meta.url).href)};
    await writeFile('observed.json', JSON.stringify(await readDependencyPublicationState({ installDir: process.cwd() })));
    await mkdir('node_modules/react-native-enriched-markdown/lib/module/web', { recursive: true });
    await writeFile('node_modules/react-native-enriched-markdown/lib/module/web/streamingReveal.js', 'complete');
  `);
  await withDependencyRefresh({ installDir: fixture.root, env }, async () => {});
  const before = await readDependencyPublicationState({ installDir: fixture.root, env });
  await ensureWebUiDependencies({ uiDir: fixture.root, env });
  const during = JSON.parse(await readFile(fixture.path('observed.json'), 'utf8'));
  assert.equal(during.writerActive, true);
  assert.notEqual(during.generation, before.generation);
});
