import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { applySourceRevision, readSourceRevisionDescriptor, resolveSourceRevision } from './source_revision.mjs';

// A real server+daemon+expo revision ships ~450 MiB of tracked input blobs
// (measured at 8a1f05937f7: 35,294 inputs). V8 strings stop at ~512 MiB, so the
// descriptor must carry blobs without one in-memory string for the whole revision.
test('a revision descriptor carries tracked inputs larger than one JavaScript string', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-revision-large-' });
  const repoDir = fixture.path('repo');
  const gitIn = (...args) => promisify(execFile)('git', ['-C', repoDir, ...args]);
  await mkdir(repoDir);
  await gitIn('init', '--quiet');
  await gitIn('config', 'user.email', 'test@example.invalid');
  await gitIn('config', 'user.name', 'test');
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({ workspaces: ['apps/*', 'packages/*'] }));
  await mkdir(join(repoDir, 'apps/cli/src'), { recursive: true });
  await writeFile(join(repoDir, 'apps/cli/package.json'), JSON.stringify({ name: '@happier-dev/cli', type: 'module' }));
  await writeFile(join(repoDir, 'apps/cli/src/index.ts'), 'export const version = "committed";');
  // Three 150 MiB inputs: 450 MiB raw, ~600 MiB as base64 text.
  const large = ['a', 'b', 'c'].map(name => `apps/cli/src/assets/${name}.bin`);
  for (const [index, path] of large.entries()) {
    await mkdir(dirname(join(repoDir, path)), { recursive: true });
    await writeFile(join(repoDir, path), Buffer.alloc(150 * 2 ** 20, index + 1));
  }
  await gitIn('add', '-A');
  await gitIn('commit', '--quiet', '-m', 'rev');
  const revision = await resolveSourceRevision({ repoDir, outputDir: fixture.path('revisions'), components: ['daemon'] });
  const descriptor = await readSourceRevisionDescriptor(revision.descriptorPath);
  assert.equal(descriptor.revision, revision.revision);
  // A host whose mirror lags restores every input from the shipped blobs.
  const captureDir = fixture.path('capture');
  const files = ['apps/cli/src/index.ts', ...large];
  await mkdir(join(captureDir, 'apps/cli/src'), { recursive: true });
  await writeFile(join(captureDir, 'apps/cli/src/index.ts'), 'export const version = "other-lane";');
  // The capture walk missed package.json: it is admitted from the revision, inside its owner.
  assert.deepEqual(await applySourceRevision({ captureDir, files, ownerDirs: ['apps/cli'], descriptor }),
    ['apps/cli/package.json', ...files].sort());
  assert.equal(await readFile(join(captureDir, 'apps/cli/src/index.ts'), 'utf8'), 'export const version = "committed";');
  for (const [index, path] of large.entries()) {
    const bytes = await readFile(join(captureDir, path));
    assert.equal(bytes.length, 150 * 2 ** 20);
    assert.ok(bytes.every(byte => byte === index + 1), `${path} must equal the revision blob`);
  }
});
