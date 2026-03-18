import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { packagePreparedTargetBinary, packageTargetBinary } from '../pipeline/release/lib/binary-release.mjs';

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

test('packageTargetBinary excludes AppleDouble metadata files from archives', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'binary-release-appledouble-'));
  const buildTempDir = join(workspace, 'build');
  const outDir = join(workspace, 'out');
  const compiledPath = join(workspace, 'happier');
  const resourcesDir = join(workspace, 'resources');
  const appleDoublePath = join(resourcesDir, '._metadata');
  const regularResourcePath = join(resourcesDir, 'metadata.txt');

  await mkdir(buildTempDir, { recursive: true });
  await mkdir(outDir, { recursive: true });
  await mkdir(resourcesDir, { recursive: true });
  await writeFile(compiledPath, '#!/usr/bin/env bash\necho happier\n', 'utf-8');
  await writeFile(appleDoublePath, 'appledouble', 'utf-8');
  await writeFile(regularResourcePath, 'ok', 'utf-8');

  try {
    const artifact = await packageTargetBinary({
      product: 'happier',
      version: '0.0.0-test',
      target: { os: 'linux', arch: 'x64', exeExt: '' },
      executableName: 'happier',
      buildTempDir,
      outDir,
      compiledPath,
      additionalStageEntries: [
        {
          sourcePath: resourcesDir,
          targetPath: 'resources',
        },
      ],
    });

    const listing = spawnSync('tar', ['-tzf', artifact.path], { encoding: 'utf-8' });
    assert.equal(listing.status, 0, listing.stderr);
    assert.match(listing.stdout, /\/resources\/metadata\.txt(?:\n|$)/);
    assert.doesNotMatch(listing.stdout, /\/resources\/\._metadata(?:\n|$)/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('packagePreparedTargetBinary excludes AppleDouble metadata files from archives', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'binary-release-prepared-appledouble-'));
  const stageRoot = join(workspace, 'stage');
  const stageDir = join(stageRoot, 'happier-v0.0.0-test-linux-x64');
  const outDir = join(workspace, 'out');

  await mkdir(join(stageDir, 'resources'), { recursive: true });
  await mkdir(outDir, { recursive: true });
  await writeFile(join(stageDir, 'happier'), '#!/usr/bin/env bash\necho happier\n', 'utf-8');
  await writeFile(join(stageDir, '._happier'), 'appledouble', 'utf-8');
  await writeFile(join(stageDir, 'resources', 'metadata.txt'), 'ok', 'utf-8');
  await writeFile(join(stageDir, 'resources', '._metadata.txt'), 'appledouble', 'utf-8');

  try {
    const artifact = await packagePreparedTargetBinary({
      product: 'happier',
      version: '0.0.0-test',
      target: { os: 'linux', arch: 'x64', exeExt: '' },
      stageDir,
      outDir,
    });

    const listing = spawnSync('tar', ['-tzf', artifact.path], { encoding: 'utf-8' });
    assert.equal(listing.status, 0, listing.stderr);
    assert.match(listing.stdout, /\/happier(?:\n|$)/);
    assert.match(listing.stdout, /\/resources\/metadata\.txt(?:\n|$)/);
    assert.doesNotMatch(listing.stdout, /\/\._happier(?:\n|$)/);
    assert.doesNotMatch(listing.stdout, /\/resources\/\._metadata\.txt(?:\n|$)/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
