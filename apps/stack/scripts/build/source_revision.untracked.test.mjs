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
