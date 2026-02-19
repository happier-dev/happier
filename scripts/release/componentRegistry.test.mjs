import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyChangedPaths } from '../pipeline/release/component-registry.mjs';

test('classifyChangedPaths flags components by prefixes and explicit files', () => {
  const flags = classifyChangedPaths([
    'apps/ui/sources/app/_layout.tsx',
    'packages/agents/src/index.ts',
    'apps/website/package.json',
    'scripts/pipeline/release/sync-installers.mjs',
    'apps/docs/content/docs/index.mdx',
    'apps/cli/src/index.ts',
    'apps/stack/package.json',
    'apps/server/sources/main.ts',
    'packages/relay-server/bin/happier-server.mjs',
  ]);

  assert.equal(flags.ui, true);
  assert.equal(flags.shared, true);
  assert.equal(flags.website, true);
  assert.equal(flags.docs, true);
  assert.equal(flags.cli, true);
  assert.equal(flags.stack, true);
  assert.equal(flags.server, true);
});

test('classifyChangedPaths treats sync-installers as a website change', () => {
  const flags = classifyChangedPaths(['scripts/pipeline/release/sync-installers.mjs']);
  assert.equal(flags.website, true);
  for (const [key, value] of Object.entries(flags)) {
    if (key === 'website') continue;
    assert.equal(value, false);
  }
});

test('classifyChangedPaths ignores unknown paths', () => {
  const flags = classifyChangedPaths(['README.md', 'random/file.txt']);
  for (const v of Object.values(flags)) assert.equal(v, false);
});
