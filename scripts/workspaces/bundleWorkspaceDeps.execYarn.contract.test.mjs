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

test('bundleWorkspaceDeps scripts route workspace builds through the shared execYarn helper', () => {
  for (const relPath of bundleWorkspaceDepsScripts) {
    const raw = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');

    assert.match(
      raw,
      /scripts\/workspaces\/execYarnCommand\.mjs/,
      `${relPath} should import the shared execYarn helper`,
    );
    assert.doesNotMatch(
      raw,
      /execFileSync\(\s*['"]yarn['"]/,
      `${relPath} should not invoke yarn directly via execFileSync`,
    );
  }
});
