// @happier-test-preparation source-condition
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { applySourceRevision, readSourceRevisionDescriptor, resolveSourceRevision } from './source_revision.mjs';

// A package's `files` entries let ignored generated outputs (dist) survive a revision capture. An
// untracked authored file under the same shipped directory is another lane's uncommitted work and must
// not (2026-11-16: an untracked apps/cli/assets/bundled-plugin-manifests/vault.json refused every
// commit-pinned QA reload with happier.vault plugin_manifest_invalid).
test('a revision capture drops untracked authored files under shipped dirs and keeps ignored outputs', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-revision-untracked-' });
  const repoDir = fixture.path('repo');
  const gitIn = (...args) => promisify(execFile)('git', ['-C', repoDir, ...args]);
  const put = async (root, path, content) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  };
  await mkdir(repoDir);
  await gitIn('init', '--quiet');
  await gitIn('config', 'user.email', 'test@example.invalid');
  await gitIn('config', 'user.name', 'test');
  await put(repoDir, 'package.json', JSON.stringify({ workspaces: ['apps/*'] }));
  await put(repoDir, '.gitignore', 'dist/\n');
  await put(repoDir, 'apps/cli/package.json', JSON.stringify({ name: '@happier-dev/cli', type: 'module',
    files: ['dist', 'assets/bundled-plugin-manifests'] }));
  await put(repoDir, 'apps/cli/src/index.ts', 'export const version = 1;');
  await put(repoDir, 'apps/cli/assets/bundled-plugin-manifests/claude.json', '{}');
  await gitIn('add', '-A');
  await gitIn('commit', '--quiet', '-m', 'rev');
  const stray = 'apps/cli/assets/bundled-plugin-manifests/vault.json';
  const output = 'apps/cli/dist/index.js';
  await put(repoDir, stray, '{"id":"happier.vault"}');
  await put(repoDir, output, 'export const version = 1;');
  const revision = await resolveSourceRevision({ repoDir, outputDir: fixture.path('revisions'), components: ['daemon'] });
  const descriptor = await readSourceRevisionDescriptor(revision.descriptorPath);
  const captureDir = fixture.path('capture');
  const files = ['apps/cli/package.json', 'apps/cli/src/index.ts', 'apps/cli/assets/bundled-plugin-manifests/claude.json', stray, output];
  for (const path of files) await put(captureDir, path, await readFile(join(repoDir, path)));
  await applySourceRevision({ captureDir, files, ownerDirs: ['apps/cli'], descriptor });
  assert.equal(existsSync(join(captureDir, stray)), false, 'an untracked authored file never enters a revision capture');
  assert.equal(existsSync(join(captureDir, output)), true, 'an ignored shipped output stays');
});

test('historical captures use revision manifests for shipped outputs and omit later package owners', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-revision-manifests-' });
  const repoDir = fixture.path('repo');
  const gitIn = (...args) => promisify(execFile)('git', ['-C', repoDir, ...args]);
  const put = async (root, path, content) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  };
  const manifest = files => JSON.stringify({ name: '@happier-dev/cli', type: 'module', files });
  await mkdir(repoDir);
  await gitIn('init', '--quiet');
  await gitIn('config', 'user.email', 'test@example.invalid');
  await gitIn('config', 'user.name', 'test');
  await put(repoDir, 'package.json', JSON.stringify({ workspaces: ['apps/*', 'packages/plugins/*'] }));
  await put(repoDir, '.gitignore', 'dist/\nnew-output/\n');
  await put(repoDir, 'apps/cli/package.json', manifest(['dist']));
  await put(repoDir, 'apps/cli/src/index.ts', 'export const version = 1;');
  await gitIn('add', '-A');
  await gitIn('commit', '--quiet', '-m', 'historical revision');
  const { stdout: rev } = await gitIn('rev-parse', 'HEAD');
  const laterOwner = 'packages/plugins/database-workbench';
  await put(repoDir, 'apps/cli/package.json', manifest(['new-output']));
  await put(repoDir, `${laterOwner}/package.json`, JSON.stringify({ name: '@happier-dev/plugins-database-workbench',
    files: ['src', 'dist', 'package.json'] }));
  await put(repoDir, `${laterOwner}/src/manifest.ts`, 'export const manifest = {};');
  await gitIn('add', '-A');
  await gitIn('commit', '--quiet', '-m', 'later plugin and changed publication');
  const oldOutput = 'apps/cli/dist/index.js';
  const newOutput = 'apps/cli/new-output/index.js';
  const laterOutput = `${laterOwner}/dist/index.js`;
  for (const path of [oldOutput, newOutput, laterOutput]) await put(repoDir, path, 'export const generated = true;');
  for (const overlay of [[], ['apps/cli/package.json']]) {
    await t.test(overlay.length ? 'explicit manifest overlay' : 'selected revision manifest', async () => {
      const revision = await resolveSourceRevision({ repoDir, rev: rev.trim(), overlay,
        outputDir: fixture.path('revisions'), components: ['daemon'] });
      const descriptor = await readSourceRevisionDescriptor(revision.descriptorPath);
      const captureDir = fixture.path(overlay.length ? 'overlay-capture' : 'capture');
      const files = ['apps/cli/package.json', 'apps/cli/src/index.ts', `${laterOwner}/package.json`,
        `${laterOwner}/src/manifest.ts`, oldOutput, newOutput, laterOutput];
      for (const path of files) await put(captureDir, path, await readFile(join(repoDir, path)));
      const captured = await applySourceRevision({ captureDir, files,
        ownerDirs: ['apps/cli', laterOwner], descriptor });
      assert.deepEqual({
        laterManifest: existsSync(join(captureDir, `${laterOwner}/package.json`)),
        laterOutput: existsSync(join(captureDir, laterOutput)),
        laterPaths: captured.some(path => path.startsWith(`${laterOwner}/`)),
        oldOutput: existsSync(join(captureDir, oldOutput)),
        newOutput: existsSync(join(captureDir, newOutput)),
      }, { laterManifest: false, laterOutput: false, laterPaths: false,
        oldOutput: !overlay.length, newOutput: Boolean(overlay.length) });
    });
  }
});

test('a mirror capture restores tracked fixtures from the revision and drops untracked fixtures', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-revision-mirror-' });
  const repoDir = fixture.path('repo');
  const gitIn = (...args) => promisify(execFile)('git', ['-C', repoDir, ...args]);
  const put = async (root, path, content) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  };
  await mkdir(repoDir);
  await gitIn('init', '--quiet');
  await gitIn('config', 'user.email', 'test@example.invalid');
  await gitIn('config', 'user.name', 'test');
  await put(repoDir, 'package.json', JSON.stringify({ workspaces: ['apps/*'] }));
  await put(repoDir, 'apps/cli/package.json', JSON.stringify({ name: '@happier-dev/cli', type: 'module' }));
  await put(repoDir, 'apps/cli/src/index.ts', 'export const value = 1;');
  const tracked = 'apps/cli/src/fixtures/effective-access-before.json';
  const untracked = 'apps/cli/src/fixtures/uncommitted.json';
  await put(repoDir, tracked, '{"revision":true}');
  await gitIn('add', '-A');
  await gitIn('commit', '--quiet', '-m', 'selected revision');
  await put(repoDir, tracked, '{"dirty":true}');
  await put(repoDir, untracked, '{"otherLane":true}');
  const revision = await resolveSourceRevision({ repoDir, outputDir: fixture.path('revisions'), components: ['daemon'] });
  const descriptor = await readSourceRevisionDescriptor(revision.descriptorPath);
  // The execution host's input walk can admit a fixture omitted by the controller's
  // walk. Its mirror has no Git objects; the descriptor must supply revision bytes.
  const captureDir = fixture.path('mirror-capture');
  const files = ['apps/cli/package.json', 'apps/cli/src/index.ts', tracked, untracked];
  for (const path of files) await put(captureDir, path, await readFile(join(repoDir, path)));
  const captured = await applySourceRevision({ captureDir, sourceDir: captureDir, files, ownerDirs: ['apps/cli'], descriptor });
  assert.equal(await readFile(join(captureDir, tracked), 'utf8'), '{"revision":true}');
  assert.equal(captured.includes(tracked), true);
  assert.equal(existsSync(join(captureDir, untracked)), false);
});
