import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { stackWorkspaceBuildBoundary } from '../proc/pm.mjs';
import { prepareStackTestWorkspacePackages } from './preparation.mjs';

for (const integration of [false, true]) test(`Stack ${integration ? 'integration' : 'unit'} preparation builds only its runtime consumer closures`, async t => {
  const { root } = await createTempFixture(t);
  const packageManager = JSON.parse(await readFile(new URL('../../../../../package.json', import.meta.url), 'utf8')).packageManager;
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, packageManager }));
  await writeFile(join(root, 'pnpm-lock.yaml'), '# disposable fixture\n');
  await writeFile(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n  - 'packages/*'\n");
  for (const [app, dependency] of [
    ['stack', '@happier-dev/fixture-stack'], ['server', 'privacy-kit'], ['cli', '@happier-dev/transfers'], ['ui', null],
  ]) {
    const dir = join(root, 'apps', app);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: `@fixture/${app}`,
      ...(dependency ? { dependencies: { [dependency]: 'workspace:*' } } : {}) }));
  }
  for (const [dirName, name, output] of [
    ['fixture-stack', '@happier-dev/fixture-stack', 'index.js'],
    ['privacy-kit', 'privacy-kit', 'index.mjs'],
    ['transfers', '@happier-dev/transfers', 'node.js'],
  ]) {
    const dir = join(root, 'packages', dirName);
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name, type: 'module', main: `./dist/${output}`,
      scripts: { build: 'fixture-compiler' } }));
    await writeFile(join(dir, 'src/index.ts'), `export const runtime = ${JSON.stringify(name)};\n`);
  }
  // Substitute only the installed-tool/compiler process boundary. Graph
  // selection, source capture, freshness and dist publication stay real.
  const workerModule = stackWorkspaceBuildBoundary.workerModule;
  delete stackWorkspaceBuildBoundary.workerModule;
  t.after(() => { stackWorkspaceBuildBoundary.workerModule = workerModule; });
  t.mock.method(stackWorkspaceBuildBoundary, 'prepareEnv', async (_dir, env) => env);
  t.mock.method(stackWorkspaceBuildBoundary, 'runPackageBuild', async (dir, { env }) => {
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    await mkdir(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, { recursive: true });
    await writeFile(join(env.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR, basename(manifest.main)),
      await readFile(join(dir, 'src/index.ts'), 'utf8'));
  });
  await prepareStackTestWorkspacePackages(join(root, 'apps/stack'), { integration,
    env: { ...process.env, HAPPIER_WORKSPACE_BUILD_MODE: 'source-dev' } });
  for (const [dir, output, expected] of [
    ['fixture-stack', 'index.js', '@happier-dev/fixture-stack'],
    ['privacy-kit', 'index.mjs', 'privacy-kit'],
    ['transfers', 'node.js', '@happier-dev/transfers'],
  ]) {
    const moduleUrl = pathToFileURL(join(root, 'packages', dir, 'dist', output)).href;
    if (!integration && dir !== 'fixture-stack') {
      await assert.rejects(import(moduleUrl), { code: 'ERR_MODULE_NOT_FOUND' },
        'the unit suite must not prepare unrelated CLI or server outputs');
      continue;
    }
    const module = await import(moduleUrl);
    assert.equal(module.runtime, expected, 'the integration source consumer can import its prepared runtime');
  }
});
