import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { sanitizePackagedNodeModulesTree } from './binary-release.mjs';

// Native-binary bundling packages that ship prebuilt binaries for every
// platform/arch inside their own package tree (instead of splitting per-target
// into optionalDependencies), so package.json os/cpu constraints alone can't
// prune them. Every single-platform CLI release tarball should only ship the
// binaries for its own target, regardless of which target that is.
const CLI_TARGETS = [
  { os: 'linux', arch: 'x64' },
  { os: 'linux', arch: 'arm64' },
  { os: 'darwin', arch: 'x64' },
  { os: 'darwin', arch: 'arm64' },
  { os: 'windows', arch: 'x64' },
];

const NESTED_PLATFORM_ARCH_PAIRS = [
  ['linux', 'x64'],
  ['linux', 'arm64'],
  ['darwin', 'x64'],
  ['darwin', 'arm64'],
  ['win32', 'x64'],
  ['win32', 'arm64'],
];

async function buildFakeOnnxruntimeNodeTree(stageDir) {
  const pkgDir = join(stageDir, 'node_modules', 'onnxruntime-node');
  await mkdir(pkgDir, { recursive: true });
  await writeFile(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'onnxruntime-node', os: ['win32', 'darwin', 'linux'] }),
    'utf-8',
  );

  for (const [platform, arch] of NESTED_PLATFORM_ARCH_PAIRS) {
    const dir = join(pkgDir, 'bin', 'napi-v3', platform, arch);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'onnxruntime_binding.node'), 'fake-binary', 'utf-8');
  }

  return pkgDir;
}

async function buildFakeFlatPrebuildsTree(stageDir, packageName) {
  const pkgDir = join(stageDir, 'node_modules', ...packageName.split('/'));
  await mkdir(pkgDir, { recursive: true });
  await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name: packageName }), 'utf-8');

  const prebuildsDir = join(pkgDir, 'prebuilds');
  for (const [platform, arch] of NESTED_PLATFORM_ARCH_PAIRS) {
    const dir = join(prebuildsDir, `${platform}-${arch}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'pty.node'), 'fake-binary', 'utf-8');
  }

  return pkgDir;
}

for (const target of CLI_TARGETS) {
  const expectedNodePlatform = target.os === 'windows' ? 'win32' : target.os;

  test(`sanitizePackagedNodeModulesTree prunes onnxruntime-node (nested layout) to ${target.os}/${target.arch} only`, async () => {
    const stageDir = await mkdtemp(join(tmpdir(), 'happier-binary-release-onnx-prune-'));
    try {
      const pkgDir = await buildFakeOnnxruntimeNodeTree(stageDir);

      await sanitizePackagedNodeModulesTree({ stageDir, target });

      const napiDir = join(pkgDir, 'bin', 'napi-v3');
      const remainingPlatforms = await readdir(napiDir);
      assert.deepEqual(remainingPlatforms, [expectedNodePlatform]);

      const remainingArches = await readdir(join(napiDir, expectedNodePlatform));
      assert.deepEqual(remainingArches, [target.arch]);
    } finally {
      await rm(stageDir, { recursive: true, force: true });
    }
  });

  for (const packageName of ['node-pty', '@homebridge/node-pty-prebuilt-multiarch']) {
    test(`sanitizePackagedNodeModulesTree prunes ${packageName} (flat layout) to ${target.os}/${target.arch} only`, async () => {
      const stageDir = await mkdtemp(join(tmpdir(), 'happier-binary-release-flat-prune-'));
      try {
        const pkgDir = await buildFakeFlatPrebuildsTree(stageDir, packageName);

        await sanitizePackagedNodeModulesTree({ stageDir, target });

        const remaining = await readdir(join(pkgDir, 'prebuilds'));
        assert.deepEqual(remaining, [`${expectedNodePlatform}-${target.arch}`]);
      } finally {
        await rm(stageDir, { recursive: true, force: true });
      }
    });
  }
}
