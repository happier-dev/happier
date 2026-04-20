import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveBootstrapRepoRoot } from './resolveBootstrapRepoRoot.mjs';

test('resolveBootstrapRepoRoot walks upward until it finds the monorepo root markers', () => {
  const root = resolveBootstrapRepoRoot({
    startDir: '/repo/apps/bootstrap/scripts',
    existsSync: (path) => (
      path === '/repo/package.json'
      || path === '/repo/yarn.lock'
    ),
  });

  assert.equal(root, '/repo');
});
