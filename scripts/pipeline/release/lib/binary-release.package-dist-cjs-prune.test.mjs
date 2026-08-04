import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { sanitizePackagedNodeModulesTree } from './binary-release.mjs';

// package-dist/ ships parallel .mjs and .cjs bundles for every file. The .cjs
// half is only consumed by the published npm package's require() entrypoint
// (a separate distribution channel); the Homebrew-installed compiled Bun
// binary only ever resolves hardcoded .mjs relative paths. Dropping the .cjs
// half from the binary-release payload saves several MB with no runtime risk.
const CLI_TARGET = { os: 'darwin', arch: 'arm64' };

async function buildFakePackageDistTree(stageDir) {
  const pkgDistDir = join(stageDir, 'package-dist');
  await mkdir(pkgDistDir, { recursive: true });

  const fileStems = ['index', 'api-CNAditUJ'];
  for (const stem of fileStems) {
    await writeFile(join(pkgDistDir, `${stem}.mjs`), 'export default 1;', 'utf-8');
    await writeFile(join(pkgDistDir, `${stem}.cjs`), 'module.exports = 1;', 'utf-8');
  }

  // Nested subdirectory should also have its .cjs files pruned.
  const nestedDir = join(pkgDistDir, 'mcp', 'bridges');
  await mkdir(nestedDir, { recursive: true });
  await writeFile(join(nestedDir, 'remoteMcpStdioBridge.mjs'), 'export default 1;', 'utf-8');
  await writeFile(join(nestedDir, 'remoteMcpStdioBridge.cjs'), 'module.exports = 1;', 'utf-8');

  return pkgDistDir;
}

test('sanitizePackagedNodeModulesTree prunes package-dist .cjs files, keeping .mjs', async () => {
  const stageDir = await mkdtemp(join(tmpdir(), 'happier-binary-release-package-dist-prune-'));
  try {
    const pkgDistDir = await buildFakePackageDistTree(stageDir);

    await sanitizePackagedNodeModulesTree({ stageDir, target: CLI_TARGET });

    const remainingTopLevel = (await readdir(pkgDistDir)).sort();
    assert.deepEqual(remainingTopLevel, ['api-CNAditUJ.mjs', 'index.mjs', 'mcp']);

    const remainingNested = await readdir(join(pkgDistDir, 'mcp', 'bridges'));
    assert.deepEqual(remainingNested, ['remoteMcpStdioBridge.mjs']);
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
});
