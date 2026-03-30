import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveBuildBinaryTarget } from './buildBinaryTarget.mjs';

test('resolves the host binary target when no override is present', () => {
  const target = resolveBuildBinaryTarget({
    bunTargetOverride: null,
    platform: 'darwin',
    arch: 'arm64',
  });

  assert.equal(target.bunTarget, 'bun-darwin-arm64');
  assert.equal(target.exeExt, '');
});

test('uses the bun target override to resolve the correct executable extension for cross-target builds', () => {
  const target = resolveBuildBinaryTarget({
    bunTargetOverride: 'bun-windows-x64',
    platform: 'darwin',
    arch: 'arm64',
  });

  assert.equal(target.bunTarget, 'bun-windows-x64');
  assert.equal(target.exeExt, '.exe');
});
