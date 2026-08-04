import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { sanitizePackagedNodeModulesTree } from './binary-release.mjs';

// bare-fs / bare-url / bare-os bundle prebuilt native binaries for every
// platform/arch inside their own package tree (flat <root>/<platform>-<arch>/
// layout, same as node-pty), so package.json os/cpu constraints alone can't
// prune them.
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

async function buildFakeFlatPrebuildsTree(stageDir, packageName) {
  const pkgDir = join(stageDir, 'node_modules', ...packageName.split('/'));
  await mkdir(pkgDir, { recursive: true });
  await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name: packageName }), 'utf-8');

  const prebuildsDir = join(pkgDir, 'prebuilds');
  for (const [platform, arch] of NESTED_PLATFORM_ARCH_PAIRS) {
    const dir = join(prebuildsDir, `${platform}-${arch}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'binding.node'), 'fake-binary', 'utf-8');
  }

  return pkgDir;
}

async function buildFakePsListTree(stageDir, { nested = false } = {}) {
  const pkgDir = nested
    ? join(stageDir, 'node_modules', '@types', 'ps-list', 'node_modules', 'ps-list')
    : join(stageDir, 'node_modules', 'ps-list');
  const vendorDir = join(pkgDir, 'vendor');
  await mkdir(vendorDir, { recursive: true });
  await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name: 'ps-list' }), 'utf-8');
  await writeFile(join(vendorDir, 'fastlist-0.3.0-x64.exe'), 'fake-exe', 'utf-8');
  await writeFile(join(vendorDir, 'fastlist-0.3.0-x86.exe'), 'fake-exe', 'utf-8');
  await writeFile(join(vendorDir, 'README.md'), 'not an exe', 'utf-8');
  return { pkgDir, vendorDir };
}

for (const target of CLI_TARGETS) {
  const expectedNodePlatform = target.os === 'windows' ? 'win32' : target.os;

  for (const packageName of ['bare-fs', 'bare-url', 'bare-os']) {
    test(`sanitizePackagedNodeModulesTree prunes ${packageName} (flat layout) to ${target.os}/${target.arch} only`, async () => {
      const stageDir = await mkdtemp(join(tmpdir(), 'happier-binary-release-bare-prune-'));
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

  test(`sanitizePackagedNodeModulesTree strips ps-list Windows-only .exe vendor files for ${target.os}/${target.arch}`, async () => {
    const stageDir = await mkdtemp(join(tmpdir(), 'happier-binary-release-ps-list-prune-'));
    try {
      const { vendorDir } = await buildFakePsListTree(stageDir);
      const { vendorDir: nestedVendorDir } = await buildFakePsListTree(stageDir, { nested: true });

      await sanitizePackagedNodeModulesTree({ stageDir, target });

      const remaining = await readdir(vendorDir);
      const nestedRemaining = await readdir(nestedVendorDir);

      if (target.os === 'windows') {
        assert.deepEqual(remaining.sort(), ['README.md', 'fastlist-0.3.0-x64.exe', 'fastlist-0.3.0-x86.exe']);
        assert.deepEqual(
          nestedRemaining.sort(),
          ['README.md', 'fastlist-0.3.0-x64.exe', 'fastlist-0.3.0-x86.exe'],
        );
      } else {
        assert.deepEqual(remaining, ['README.md']);
        assert.deepEqual(nestedRemaining, ['README.md']);
      }
    } finally {
      await rm(stageDir, { recursive: true, force: true });
    }
  });
}
