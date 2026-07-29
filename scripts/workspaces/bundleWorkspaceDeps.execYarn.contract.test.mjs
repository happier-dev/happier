import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();

const bundleWorkspaceDepsScripts = [
  'apps/cli/scripts/bundleWorkspaceDeps.mjs',
  'apps/stack/scripts/bundleWorkspaceDeps.mjs',
  'packages/relay-server/scripts/bundleWorkspaceDeps.mjs',
  'packages/support/scripts/bundleWorkspaceDeps.mjs',
];

test('bundleWorkspaceDeps scripts delegate workspace dist admission to the canonical owner', () => {
  for (const relPath of bundleWorkspaceDepsScripts) {
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
});
