import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();

const specializedBundleWorkspaceDepsScripts = [
  'apps/cli/scripts/bundleWorkspaceDeps.mjs',
  'apps/stack/scripts/bundleWorkspaceDeps.mjs',
];

const genericBundleWorkspaceDepsAdapters = [
  'packages/plugin-sdk/scripts/bundleWorkspaceDeps.mjs',
  'packages/sdk/scripts/bundleWorkspaceDeps.mjs',
  'packages/relay-server/scripts/bundleWorkspaceDeps.mjs',
  'packages/support/scripts/bundleWorkspaceDeps.mjs',
];

test('bundleWorkspaceDeps scripts delegate workspace dist admission to the canonical owner', () => {
  for (const relPath of specializedBundleWorkspaceDepsScripts) {
    const raw = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');

    assert.match(
      raw,
      /ensureWorkspacePackagesBuiltByName/,
      `${relPath} should delegate missing workspace outputs to the canonical owner`,
    );
    assert.doesNotMatch(
      raw,
      /execYarn|execFileSync\(\s*['"]yarn['"]/,
      `${relPath} should not retain a direct Yarn workspace-build path`,
    );
  }

  for (const relPath of genericBundleWorkspaceDepsAdapters) {
    const raw = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
    assert.match(
      raw,
      /bundleWorkspacePackageDependencies/u,
      `${relPath} should delegate generic dependency publication to the root owner`,
    );
    assert.doesNotMatch(
      raw,
      /execYarn|execFileSync\(\s*['"]yarn['"]|loadCliCommonWorkspacesModule/u,
      `${relPath} should not retain package-local graph loading or direct Yarn builds`,
    );
  }
});
