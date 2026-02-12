import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { packageTargetBinary } from './lib/binary_release.mjs';

test('packageTargetBinary includes additional stage entries in archive', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'binary-release-package-'));
  const buildTempDir = join(workspace, 'build');
  const outDir = join(workspace, 'out');
  const generatedSqliteDir = join(workspace, 'generated', 'sqlite-client');
  const compiledPath = join(workspace, 'happier-server');

  await mkdir(buildTempDir, { recursive: true });
  await mkdir(outDir, { recursive: true });
  await mkdir(generatedSqliteDir, { recursive: true });
  await writeFile(compiledPath, '#!/usr/bin/env bash\necho server\n', 'utf-8');
  await writeFile(join(generatedSqliteDir, 'index.js'), 'export class PrismaClient {}\n', 'utf-8');

  try {
    const artifact = await packageTargetBinary({
      product: 'happier-server',
      version: '0.0.0-test',
      target: { os: 'linux', arch: 'x64', exeExt: '' },
      executableName: 'happier-server',
      buildTempDir,
      outDir,
      compiledPath,
      additionalStageEntries: [
        {
          sourcePath: generatedSqliteDir,
          targetPath: join('generated', 'sqlite-client'),
        },
      ],
    });

    const extractDir = await mkdtemp(join(tmpdir(), 'binary-release-extract-'));
    const untar = spawnSync('tar', ['-xzf', artifact.path, '-C', extractDir], { encoding: 'utf-8' });
    assert.equal(untar.status, 0, untar.stderr);

    const extractedIndex = join(
      extractDir,
      'happier-server-v0.0.0-test-linux-x64',
      'generated',
      'sqlite-client',
      'index.js',
    );
    const content = await readFile(extractedIndex, 'utf-8');
    assert.match(content, /PrismaClient/);

    await rm(extractDir, { recursive: true, force: true });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
