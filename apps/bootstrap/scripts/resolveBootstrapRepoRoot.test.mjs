import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveBootstrapRepoRoot } from './resolveBootstrapRepoRoot.mjs';

test('resolveBootstrapRepoRoot walks upward until it finds the monorepo root markers', () => {
  const root = resolveBootstrapRepoRoot({
    startDir: '/repo/apps/bootstrap/scripts/nested',
    existsSync: (path) => (
      path === '/repo/package.json'
      || path === '/repo/pnpm-lock.yaml'
      || path === '/repo/pnpm-workspace.yaml'
    ),
  });

  assert.equal(root, '/repo');
});
