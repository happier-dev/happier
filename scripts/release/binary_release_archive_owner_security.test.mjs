import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as tar from 'tar';

import { resolveTarCreateArgs } from '../pipeline/release/lib/archive-tar-options.mjs';

test('root release archive helper owns its exact tar dependency', async () => {
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  const rootManifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  const helperSource = await readFile(
    join(repoRoot, 'scripts', 'pipeline', 'release', 'node-archive.mjs'),
    'utf8',
  );

  assert.match(helperSource, /from ['"]tar['"]/u);
  assert.equal(rootManifest.devDependencies?.tar, '7.5.22');
  assert.equal(rootManifest.resolutions?.tar, '7.5.22');
});

test('packed-candidate harness owns its exact tar dependency', async () => {
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  const testsManifest = JSON.parse(
    await readFile(join(repoRoot, 'packages', 'tests', 'package.json'), 'utf8'),
  );
  const harnessSource = await readFile(
    join(
      repoRoot,
      'packages',
      'tests',
      'scripts',
      'plugin-platform',
      'packed-author-artifact-boundary.mjs',
    ),
    'utf8',
  );

  assert.match(harnessSource, /from ['"]tar['"]/u);
  assert.equal(testsManifest.devDependencies?.tar, '7.5.22');
});

async function readArchiveEntries(artifactPath) {
  const entries = [];
  await tar.t({
    file: artifactPath,
    onentry: (entry) => {
      entries.push({
        path: entry.path,
        type: entry.type,
        mode: entry.mode,
        uid: entry.uid,
        gid: entry.gid,
        linkpath: entry.linkpath,
      });
      entry.resume();
    },
  });
  return entries;
}

test('GNU tar and libarchive creation options both normalize numeric ownership', () => {
  const common = {
    excludeArgs: ['--exclude=._*'],
    artifactArg: '../out/payload.tar.gz',
    sourceDirArg: '.',
    sourceNameArg: 'payload',
    compressed: true,
  };

  const gnuArgs = resolveTarCreateArgs({ ...common, isGnuTar: true });
  assert.ok(gnuArgs.includes('--owner=0'));
  assert.ok(gnuArgs.includes('--group=0'));
  assert.ok(gnuArgs.includes('--numeric-owner'));

  const libarchiveArgs = resolveTarCreateArgs({ ...common, isGnuTar: false });
  assert.deepEqual(
    libarchiveArgs.slice(0, 6),
    ['--no-mac-metadata', '--uid', '0', '--gid', '0', '--numeric-owner'],
  );
});

test('native tar backend strips builder ownership while preserving entry types and modes', async (t) => {
  const tempRoot = process.platform === 'darwin' ? '/private/tmp/' : `${tmpdir()}/`;
  const workspace = await mkdtemp(join(tempRoot, 'happier-archive-owner-normalization-'));
  const sourceRoot = join(workspace, 'source');
  const sourceName = 'payload';
  const payloadRoot = join(sourceRoot, sourceName);
  const executablePath = join(payloadRoot, 'run.sh');
  const artifactPath = join(workspace, 'out', 'payload.tar.gz');

  await mkdir(join(workspace, 'out'), { recursive: true });
  await mkdir(payloadRoot, { recursive: true });
  await writeFile(executablePath, '#!/usr/bin/env bash\nexit 0\n', 'utf8');
  await chmod(executablePath, 0o755);
  await symlink('run.sh', join(payloadRoot, 'run-link'));

  try {
    const sourceStats = await stat(executablePath);
    if (sourceStats.uid === 0 && sourceStats.gid === 0) {
      t.skip('requires a non-root builder identity to discriminate owner normalization');
      return;
    }

    const version = spawnSync('tar', ['--version'], { encoding: 'utf8' });
    assert.equal(version.status, 0, version.stderr);
    const args = resolveTarCreateArgs({
      isGnuTar: String(version.stdout).includes('GNU tar'),
      excludeArgs: ['--exclude=._*', '--exclude=*/._*'],
      artifactArg: relative(sourceRoot, artifactPath),
      sourceDirArg: '.',
      sourceNameArg: sourceName,
      compressed: true,
    });
    const creation = spawnSync('tar', args, {
      cwd: sourceRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        COPYFILE_DISABLE: '1',
        COPY_EXTENDED_ATTRIBUTES_DISABLE: '1',
      },
    });
    assert.equal(creation.status, 0, creation.stderr);

    const entries = await readArchiveEntries(artifactPath);

    assert.ok(entries.length >= 3, 'expected root, executable, and symlink entries');
    for (const entry of entries) {
      assert.equal(entry.uid, 0, `expected normalized uid for ${entry.path}`);
      assert.equal(entry.gid, 0, `expected normalized gid for ${entry.path}`);
    }
    assert.deepEqual(
      (({ path, type, mode, uid, gid }) => ({ path, type, mode, uid, gid }))(
        entries.find((entry) => entry.path === 'payload/run.sh'),
      ),
      {
        path: 'payload/run.sh',
        type: 'File',
        mode: 0o755,
        uid: 0,
        gid: 0,
      },
    );
    assert.deepEqual(
      entries.find((entry) => entry.path === 'payload/run-link'),
      {
        path: 'payload/run-link',
        type: 'SymbolicLink',
        mode: 0o755,
        uid: 0,
        gid: 0,
        linkpath: 'run.sh',
      },
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('portable Node archive backend strips builder ownership', async (t) => {
  const tempRoot = process.platform === 'darwin' ? '/private/tmp/' : `${tmpdir()}/`;
  const workspace = await mkdtemp(join(tempRoot, 'happier-node-archive-owner-normalization-'));
  const sourceRoot = join(workspace, 'source');
  const sourceName = 'payload';
  const executablePath = join(sourceRoot, sourceName, 'run.sh');
  const artifactPath = join(workspace, 'out', 'payload.tar.gz');

  await mkdir(join(sourceRoot, sourceName), { recursive: true });
  await writeFile(executablePath, '#!/usr/bin/env bash\nexit 0\n', 'utf8');
  await chmod(executablePath, 0o755);

  try {
    const sourceStats = await stat(executablePath);
    if (sourceStats.uid === 0 && sourceStats.gid === 0) {
      t.skip('requires a non-root builder identity to discriminate owner normalization');
      return;
    }

    const helperPath = fileURLToPath(new URL('../pipeline/release/node-archive.mjs', import.meta.url));
    const creation = spawnSync(process.execPath, [
      helperPath,
      '--source-path',
      sourceRoot,
      '--source-name',
      sourceName,
      '--artifact-path',
      artifactPath,
    ], { encoding: 'utf8' });
    assert.equal(creation.status, 0, creation.stderr);

    const entries = await readArchiveEntries(artifactPath);
    assert.ok(entries.length >= 2, 'expected root and executable entries');
    for (const entry of entries) {
      // node-tar's portable format omits owner fields; readers resolve those empty fields as zero.
      assert.ok(entry.uid == null || entry.uid === 0, `expected normalized uid for ${entry.path}`);
      assert.ok(entry.gid == null || entry.gid === 0, `expected normalized gid for ${entry.path}`);
    }
    assert.equal(entries.find((entry) => entry.path === 'payload/run.sh')?.mode, 0o755);

    const extractRoot = join(workspace, 'extract');
    const extraction = spawnSync(process.execPath, [
      helperPath,
      '--extract-archive-path',
      artifactPath,
      '--extract-dir',
      extractRoot,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: '',
      },
    });
    assert.equal(
      extraction.status,
      0,
      `expected the release helper to use the in-process bounded extractor: ${extraction.stderr}`,
    );
    assert.equal((await stat(join(extractRoot, 'payload', 'run.sh'))).mode & 0o777, 0o755);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
