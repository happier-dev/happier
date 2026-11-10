// @happier-test-preparation source
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { linkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { installSourceAdmissionFixture, installSourcePreparationInputs } from '../testkit/core/source_runtime_fixture.mjs';

test('daemon source capture preserves an author closure larger than the engine argument limit', async context => {
  const fixture = await createTempFixture(context, { prefix: 'source-author-scale-' });
  const { build, env } = await installSourceAdmissionFixture(fixture.root);
  const repoDir = fixture.path('repo');
  const cliDir = join(repoDir, 'apps/cli');
  const sdkDir = join(repoDir, 'packages/plugin-sdk');
  for (const path of [join(cliDir, 'src'), join(cliDir, 'node_modules'), join(sdkDir, 'src'),
    join(sdkDir, 'assets'), join(repoDir, 'node_modules/@happier-dev')]) await mkdir(path, { recursive: true });
  await writeFile(join(cliDir, 'package.json'), JSON.stringify({ name: '@happier-dev/cli', type: 'module',
    dependencies: { '@happier-dev/plugin-sdk': '0.0.0' }, bundledDependencies: ['@happier-dev/plugin-sdk'], exports: {} }));
  await writeFile(join(cliDir, 'tsconfig.json'), '{}');
  await writeFile(join(cliDir, 'src/index.ts'), 'export const ready = true;');
  await writeFile(join(sdkDir, 'package.json'), JSON.stringify({ name: '@happier-dev/plugin-sdk', version: '0.0.0',
    type: 'module', main: './dist/index.js', files: ['dist', 'assets'],
    exports: { '.': { 'happier-source': './src/index.ts', default: './dist/index.js' } },
    happier: { publicSdkRelease: { posture: 'developer_preview' } } }));
  await writeFile(join(sdkDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022',
    module: 'NodeNext', moduleResolution: 'NodeNext', rootDir: 'src', outDir: 'dist' }, include: ['src/**/*.ts'] }));
  await writeFile(join(sdkDir, 'src/index.ts'), 'export const ready = true;');
  await symlink(sdkDir, join(repoDir, 'node_modules/@happier-dev/plugin-sdk'), process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(cliDir, 'node_modules/esbuild'),
    process.platform === 'win32' ? 'junction' : 'dir');
  await installSourcePreparationInputs(repoDir, 'daemon');
  // reload145 had 127,279 author files. Hard links keep this real filesystem
  // fixture small while exercising the complete producer and manifest inventory.
  const files = 130_000;
  let resource;
  for (let index = 0; index < files; index++) {
    const path = join(sdkDir, `assets/${index}.bin`);
    // Stay below platform hard-link limits without allocating one data block per path.
    if (index % 500 === 0) {
      writeFileSync(path, new Uint8Array([0, 255, 17]));
      resource = path;
    } else linkSync(resource, path);
  }
  const result = await build({ repoDir, outputDir: fixture.path('output'), component: 'daemon', env });
  const assets = join(result.runtimeDir, 'authoring/node_modules/@happier-dev/plugin-sdk/assets');
  assert.deepEqual(await readFile(join(assets, `${files - 1}.bin`)), Buffer.from([0, 255, 17]));
  await writeFile(join(sdkDir, `assets/${files - 1}.bin`), new Uint8Array([0, 255, 18]));
  const changed = await build({ repoDir, outputDir: fixture.path('changed-output'), component: 'daemon', env });
  assert.notEqual(changed.identity, result.identity, 'late author resources must participate in runtime identity');
});
