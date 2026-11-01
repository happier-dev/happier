import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { readSourceAuthorDependencyIdentity } from './source_author_inputs.mjs';

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
