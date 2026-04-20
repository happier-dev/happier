import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { createDeterministicArchive, packagePreparedTargetBinary, packageTargetBinary } from '../pipeline/release/lib/binary-release.mjs';

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

test('packagePreparedTargetBinary excludes nested @prisma/client node_modules (not needed at runtime, avoids tar flake)', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'binary-release-prisma-client-nodemodules-'));
  const stageRoot = join(workspace, 'stage');
  const stageDir = join(stageRoot, 'happier-server-v0.0.0-test-linux-x64');
  const outDir = join(workspace, 'out');

  const prismaNested = join(stageDir, 'node_modules', '@prisma', 'client', 'node_modules');
  await mkdir(join(prismaNested, '.bin'), { recursive: true });
  await mkdir(outDir, { recursive: true });
  await writeFile(join(stageDir, 'happier-server'), '#!/usr/bin/env bash\necho server\n', 'utf-8');
  await writeFile(join(prismaNested, '.bin', 'dummy'), 'ok', 'utf-8');

  try {
    const artifact = await packagePreparedTargetBinary({
      product: 'happier-server',
      version: '0.0.0-test',
      target: { os: 'linux', arch: 'x64', exeExt: '' },
      stageDir,
      outDir,
    });

    const listing = spawnSync('tar', ['-tzf', artifact.path], { encoding: 'utf-8' });
    assert.equal(listing.status, 0, listing.stderr);
    assert.match(listing.stdout, /\/happier-server(?:\n|$)/);
    assert.doesNotMatch(listing.stdout, /\/node_modules\/@prisma\/client\/node_modules(?:\/|\n|$)/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('packagePreparedTargetBinary excludes nested node_modules/.bin shim directories from archives', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'binary-release-node-bin-'));
  const stageRoot = join(workspace, 'stage');
  const stageDir = join(stageRoot, 'happier-v0.0.0-test-windows-x64');
  const outDir = join(workspace, 'out');

  const packageDir = join(stageDir, 'node_modules', 'fastify');
  const binDir = join(packageDir, 'node_modules', '.bin');
  await mkdir(binDir, { recursive: true });
  await mkdir(outDir, { recursive: true });
  await writeFile(join(stageDir, 'happier.exe'), 'binary', 'utf-8');
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: 'fastify', version: '0.0.0-test' }), 'utf-8');
  await writeFile(join(binDir, 'pino'), 'shim', 'utf-8');

  try {
    const artifact = await packagePreparedTargetBinary({
      product: 'happier',
      version: '0.0.0-test',
      target: { os: 'windows', arch: 'x64', exeExt: '.exe' },
      stageDir,
      outDir,
    });

    const listing = spawnSync('tar', ['-tzf', artifact.path], { encoding: 'utf-8' });
    assert.equal(listing.status, 0, listing.stderr);
    assert.match(listing.stdout, /\/node_modules\/fastify\/package\.json(?:\n|$)/);
    assert.doesNotMatch(listing.stdout, /\/node_modules\/fastify\/node_modules\/\.bin(?:\/|\n|$)/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('packagePreparedTargetBinary excludes target-incompatible package directories from archives', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'binary-release-platform-prune-'));
  const stageRoot = join(workspace, 'stage');
  const stageDir = join(stageRoot, 'happier-v0.0.0-test-windows-x64');
  const outDir = join(workspace, 'out');

  const darwinSharpDir = join(stageDir, 'node_modules', '@img', 'sharp-darwin-arm64');
  const windowsSharpDir = join(stageDir, 'node_modules', '@img', 'sharp-win32-x64');
  await mkdir(darwinSharpDir, { recursive: true });
  await mkdir(windowsSharpDir, { recursive: true });
  await mkdir(outDir, { recursive: true });
  await writeFile(join(stageDir, 'happier.exe'), 'binary', 'utf-8');
  await writeFile(
    join(darwinSharpDir, 'package.json'),
    JSON.stringify({
      name: '@img/sharp-darwin-arm64',
      version: '0.0.0-test',
      os: ['darwin'],
      cpu: ['arm64'],
    }),
    'utf-8',
  );
  await writeFile(join(darwinSharpDir, 'marker.txt'), 'darwin-only', 'utf-8');
  await writeFile(
    join(windowsSharpDir, 'package.json'),
    JSON.stringify({
      name: '@img/sharp-win32-x64',
      version: '0.0.0-test',
      os: ['win32'],
      cpu: ['x64'],
    }),
    'utf-8',
  );
  await writeFile(join(windowsSharpDir, 'marker.txt'), 'windows-ok', 'utf-8');

  try {
    const artifact = await packagePreparedTargetBinary({
      product: 'happier',
      version: '0.0.0-test',
      target: { os: 'windows', arch: 'x64', exeExt: '.exe' },
      stageDir,
      outDir,
    });

    const listing = spawnSync('tar', ['-tzf', artifact.path], { encoding: 'utf-8' });
    assert.equal(listing.status, 0, listing.stderr);
    assert.match(listing.stdout, /\/node_modules\/@img\/sharp-win32-x64\/marker\.txt(?:\n|$)/);
    assert.doesNotMatch(listing.stdout, /\/node_modules\/@img\/sharp-darwin-arm64(?:\/|\n|$)/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('createDeterministicArchive disables macOS copyfile and xattr metadata when invoking tar', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'binary-release-tar-env-'));
  const fakeBinDir = join(workspace, 'bin');
  const sourceRoot = join(workspace, 'source');
  const sourceName = 'payload';
  const artifactPath = join(workspace, 'out', 'payload.tar.gz');
  const logPath = join(workspace, 'tar-env.log');
  const fakeTarPath = join(fakeBinDir, 'tar');

  await mkdir(fakeBinDir, { recursive: true });
  await mkdir(join(sourceRoot, sourceName), { recursive: true });
  await writeFile(join(sourceRoot, sourceName, 'hello.txt'), 'ok', 'utf-8');
  await writeFile(fakeTarPath, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "--version" ]]; then
  echo "bsdtar 3.6.2"
  exit 0
fi
printf 'COPYFILE_DISABLE=%s\nCOPY_EXTENDED_ATTRIBUTES_DISABLE=%s\nARGS=%s\n' "\${COPYFILE_DISABLE:-}" "\${COPY_EXTENDED_ATTRIBUTES_DISABLE:-}" "$*" > "$LOG_PATH"
args=("$@")
for ((i=0; i<\${#args[@]}; i++)); do
  if [[ "\${args[$i]}" == "-czf" && $((i + 1)) -lt \${#args[@]} ]]; then
    : > "\${args[$((i + 1))]}"
    exit 0
  fi
done
exit 99
`, { mode: 0o755 });

  try {
    const child = spawnSync(process.execPath, [
      '--input-type=module',
      '-e',
      `import { createDeterministicArchive } from ${JSON.stringify(new URL('../pipeline/release/lib/binary-release.mjs', import.meta.url).href)};
await createDeterministicArchive({
  artifactPath: process.env.TEST_ARTIFACT_PATH,
  sourcePath: process.env.TEST_SOURCE_ROOT,
  sourceName: process.env.TEST_SOURCE_NAME,
});`,
    ], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        LOG_PATH: logPath,
        PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
        TEST_ARTIFACT_PATH: artifactPath,
        TEST_SOURCE_ROOT: sourceRoot,
        TEST_SOURCE_NAME: sourceName,
      },
    });

    assert.equal(child.status, 0, child.stderr);
    const log = await readFile(logPath, 'utf-8');
    assert.match(log, /^COPYFILE_DISABLE=1$/m);
    assert.match(log, /^COPY_EXTENDED_ATTRIBUTES_DISABLE=1$/m);
    assert.match(log, /ARGS=.*--no-mac-metadata/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
