import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { sanitizePackagedNodeModulesTree } from './binary-release.mjs';

// onnxruntime-node bundles prebuilt native binaries for every platform/arch inside
// its own package tree (bin/napi-v<N>/<platform>/<arch>/...) rather than splitting
// them into per-target optionalDependencies. A single-platform CLI release tarball
// should only ship the binaries for its own target.
async function buildFakeOnnxruntimeNodeTree(stageDir) {
  const pkgDir = join(stageDir, 'node_modules', 'onnxruntime-node');
  await writeFile(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'onnxruntime-node', os: ['win32', 'darwin', 'linux'] }),
    'utf-8',
  ).catch(async (error) => {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'onnxruntime-node', os: ['win32', 'darwin', 'linux'] }),
      'utf-8',
    );
  });

  const platformArchPairs = [
    ['linux', 'x64'],
    ['linux', 'arm64'],
    ['darwin', 'x64'],
    ['darwin', 'arm64'],
    ['win32', 'x64'],
    ['win32', 'arm64'],
  ];
  for (const [platform, arch] of platformArchPairs) {
    const dir = join(pkgDir, 'bin', 'napi-v3', platform, arch);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'onnxruntime_binding.node'), 'fake-binary', 'utf-8');
  }

  return pkgDir;
}

test('sanitizePackagedNodeModulesTree prunes onnxruntime-node bundled binaries to the packaging target only', async () => {
  const stageDir = await mkdtemp(join(tmpdir(), 'happier-binary-release-onnx-prune-'));

  try {
    const pkgDir = await buildFakeOnnxruntimeNodeTree(stageDir);

    await sanitizePackagedNodeModulesTree({
      stageDir,
      target: { os: 'darwin', arch: 'arm64' },
    });

    const napiDir = join(pkgDir, 'bin', 'napi-v3');
    const remainingPlatforms = await readdir(napiDir);
    assert.deepEqual(remainingPlatforms.sort(), ['darwin']);

    const remainingArches = await readdir(join(napiDir, 'darwin'));
    assert.deepEqual(remainingArches, ['arm64']);
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
});

test('sanitizePackagedNodeModulesTree keeps only the matching arch for windows targets', async () => {
  const stageDir = await mkdtemp(join(tmpdir(), 'happier-binary-release-onnx-prune-win-'));

  try {
    const pkgDir = await buildFakeOnnxruntimeNodeTree(stageDir);

    await sanitizePackagedNodeModulesTree({
      stageDir,
      // buildBinaryTarget.mjs uses os: 'windows'; resolveTargetNodePlatform maps it to 'win32'.
      target: { os: 'windows', arch: 'x64' },
    });

    const napiDir = join(pkgDir, 'bin', 'napi-v3');
    const remainingPlatforms = await readdir(napiDir);
    assert.deepEqual(remainingPlatforms.sort(), ['win32']);

    const remainingArches = await readdir(join(napiDir, 'win32'));
    assert.deepEqual(remainingArches, ['x64']);
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
});
