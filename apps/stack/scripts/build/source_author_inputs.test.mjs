import assert from 'node:assert/strict';
import { mkdir, rename, symlink, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { readSourceAuthorDependencyIdentity, readSourceRuntimeDependencyIdentity } from './source_author_inputs.mjs';

test('runtime dependency identity survives identical installed-file replacement but rejects changed bytes', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-runtime-input-content-' });
  const dependency = fixture.path('node_modules/runtime-input');
  await mkdir(dependency, { recursive: true });
  await writeFile(`${dependency}/package.json`, JSON.stringify({ name: 'runtime-input', main: 'index.cjs' }));
  const entry = `${dependency}/index.cjs`;
  const contents = 'exports.value = 1;';
  await writeFile(entry, contents);
  const readIdentity = () => readSourceRuntimeDependencyIdentity({
    imports: [{ path: 'runtime-input', resolveFrom: fixture.path('package.json') }],
  });
  const before = readIdentity();
  await writeFile(`${entry}.replacement`, contents);
  await rename(`${entry}.replacement`, entry);
  assert.equal(readIdentity(), before, 'a dependency refresh replacing identical bytes preserves the retained runtime');
  await writeFile(entry, 'exports.value = 2;');
  assert.notEqual(readIdentity(), before, 'changed same-size runtime code must still invalidate the retained runtime');
});

test('source author identity ignores module metadata files and follows scoped package directories', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-source-author-inputs-' });
  const repoDir = fixture.path('repo');
  const stackDir = fixture.path('repo/apps/stack');
  const scope = fixture.path('repo/apps/stack/node_modules/@happier-dev');
  const externalScope = fixture.path('repo/apps/stack/node_modules/@external');
  const dependency = fixture.path('installed/dependency');
  await Promise.all([scope, externalScope, dependency].map(path => mkdir(path, { recursive: true })));
  await writeFile(fixture.path('compiler.js'), '// compiler');
  await writeFile(`${dependency}/package.json`, JSON.stringify({ name: '@external/dependency' }));
  await writeFile(`${dependency}/index.js`, 'export const value = 1;');
  await symlink(dependency, `${externalScope}/dependency`, process.platform === 'win32' ? 'junction' : 'dir');
  const readIdentity = () => readSourceAuthorDependencyIdentity({
    sourceRepoDir: repoDir,
    repoDir,
    workspacePackages: new Map([['@happier-dev/stack', { root: stackDir }]]),
    compilerPath: fixture.path('compiler.js'),
  });
  const before = readIdentity();
  await writeFile(`${scope}/.workspace-bundle-manifest.json`, '{}');
  await writeFile(`${externalScope}/.workspace-bundle-manifest.json`, '{}');
  await writeFile(`${externalScope}/metadata.json`, '{}');
  assert.equal(readIdentity(), before, 'regular scope entries are not installed package directories');
  await writeFile(`${dependency}/index.js`, 'export const value = 200;');
  assert.notEqual(readIdentity(), before, 'a real symlinked scoped dependency remains an authoring input');
});
