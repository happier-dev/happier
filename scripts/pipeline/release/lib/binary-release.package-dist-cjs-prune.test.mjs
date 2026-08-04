import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { sanitizePackagedNodeModulesTree } from './binary-release.mjs';

// package-dist/ ships parallel .mjs and .cjs bundles for every file, plus
// .d.mts/.d.cts type-declaration siblings. The .cjs half is only consumed by
// the published npm package's require() entrypoint (a separate distribution
// channel); the .d.mts/.d.cts files are only consulted by third-party
// tooling (tsc, editors) resolving this package's npm "exports" map. The
// Homebrew-installed compiled Bun binary only ever resolves hardcoded .mjs
// relative paths and is never require()'d or type-checked as a library, so
// none of .cjs/.d.mts/.d.cts are reachable at runtime. Dropping them from the
// binary-release payload saves several hundred KB-to-MB with no runtime risk.
const CLI_TARGETS = [
  { os: 'darwin', arch: 'arm64' },
  { os: 'darwin', arch: 'x64' },
  { os: 'linux', arch: 'arm64' },
  { os: 'linux', arch: 'x64' },
  { os: 'windows', arch: 'x64' },
];

async function buildFakePackageDistTree(stageDir) {
  const pkgDistDir = join(stageDir, 'package-dist');
  await mkdir(pkgDistDir, { recursive: true });

  const fileStems = ['index', 'api-CNAditUJ'];
  for (const stem of fileStems) {
    await writeFile(join(pkgDistDir, `${stem}.mjs`), 'export default 1;', 'utf-8');
    await writeFile(join(pkgDistDir, `${stem}.cjs`), 'module.exports = 1;', 'utf-8');
  }
  // Only the top-level index has .d.mts/.d.cts siblings, mirroring the real
  // package-dist layout (index, lib, and a few nested entrypoints).
  await writeFile(join(pkgDistDir, 'index.d.mts'), 'export declare const x: number;', 'utf-8');
  await writeFile(join(pkgDistDir, 'index.d.cts'), 'export declare const x: number;', 'utf-8');

  // Nested subdirectory should also have its .cjs/.d.mts/.d.cts files pruned.
  const nestedDir = join(pkgDistDir, 'mcp', 'bridges');
  await mkdir(nestedDir, { recursive: true });
  await writeFile(join(nestedDir, 'remoteMcpStdioBridge.mjs'), 'export default 1;', 'utf-8');
  await writeFile(join(nestedDir, 'remoteMcpStdioBridge.cjs'), 'module.exports = 1;', 'utf-8');
  await writeFile(join(nestedDir, 'remoteMcpStdioBridge.d.mts'), 'export declare const y: number;', 'utf-8');
  await writeFile(join(nestedDir, 'remoteMcpStdioBridge.d.cts'), 'export declare const y: number;', 'utf-8');

  return pkgDistDir;
}

for (const target of CLI_TARGETS) {
  test(`sanitizePackagedNodeModulesTree prunes package-dist .cjs/.d.mts/.d.cts files, keeping .mjs [${target.os}/${target.arch}]`, async () => {
    const stageDir = await mkdtemp(join(tmpdir(), 'happier-binary-release-package-dist-prune-'));
    try {
      const pkgDistDir = await buildFakePackageDistTree(stageDir);

      await sanitizePackagedNodeModulesTree({ stageDir, target });

      const remainingTopLevel = (await readdir(pkgDistDir)).sort();
      assert.deepEqual(remainingTopLevel, ['api-CNAditUJ.mjs', 'index.mjs', 'mcp']);

      const remainingNested = await readdir(join(pkgDistDir, 'mcp', 'bridges'));
      assert.deepEqual(remainingNested, ['remoteMcpStdioBridge.mjs']);
    } finally {
      await rm(stageDir, { recursive: true, force: true });
    }
  });
}
