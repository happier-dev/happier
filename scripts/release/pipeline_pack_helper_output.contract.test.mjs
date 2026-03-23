import test from 'node:test';
import assert from 'node:assert/strict';

import { resolvePackedTarball } from '../pipeline/npm/resolvePackedTarball.mjs';

test('resolvePackedTarball accepts absolute tarball paths from the CLI pack helper', () => {
  const result = resolvePackedTarball(
    '/tmp/happier-dev-cli-0.1.0.tgz',
    { cwd: '/work/apps/cli', sourceLabel: 'CLI pack helper' },
  );

  assert.equal(result.filename, 'happier-dev-cli-0.1.0.tgz');
  assert.equal(result.tgzPath, '/tmp/happier-dev-cli-0.1.0.tgz');
});

test('resolvePackedTarball accepts npm pack --json payloads', () => {
  const result = resolvePackedTarball(
    JSON.stringify([{ filename: 'happier-dev-cli-0.1.0.tgz' }]),
    { cwd: '/work/apps/cli', sourceLabel: 'npm pack --json' },
  );

  assert.equal(result.filename, 'happier-dev-cli-0.1.0.tgz');
  assert.equal(result.tgzPath, '/work/apps/cli/happier-dev-cli-0.1.0.tgz');
});
