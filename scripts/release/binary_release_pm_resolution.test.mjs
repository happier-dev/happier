import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import { resolveRepoRoot, resolveYarnCommand } from '../pipeline/release/lib/binary-release.mjs';

test('resolveYarnCommand prefers yarn when both yarn and corepack are available', () => {
  const result = resolveYarnCommand({
    commandProbe: (cmd) => cmd === 'yarn' || cmd === 'corepack',
  });
  assert.deepEqual(result, { cmd: 'yarn', args: [] });
});

test('resolveYarnCommand falls back to corepack yarn when yarn shim is missing', () => {
  const result = resolveYarnCommand({
    commandProbe: (cmd) => cmd === 'corepack',
  });
  assert.deepEqual(result, { cmd: 'corepack', args: ['yarn'] });
});

test('resolveYarnCommand throws when yarn and corepack are unavailable', () => {
  assert.throws(
    () => resolveYarnCommand({ commandProbe: () => false }),
    /requires yarn .* corepack/i
  );
});

test('resolveRepoRoot resolves the repo root from the module location', () => {
  assert.equal(resolve(resolveRepoRoot()), resolve(process.cwd()));
});
