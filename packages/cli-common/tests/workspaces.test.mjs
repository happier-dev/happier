import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { findRepoRoot } from '../dist/workspaces/index.js';

test('findRepoRoot returns the nearest repo root marker directory', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'cli-common-workspaces-root-'));
  try {
    const repoRoot = join(tempRoot, 'repo');
    const nested = join(repoRoot, 'apps', 'stack', 'scripts');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(repoRoot, 'package.json'), '{}\n', 'utf8');
    writeFileSync(join(repoRoot, 'yarn.lock'), '\n', 'utf8');
    assert.equal(findRepoRoot(nested), repoRoot);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('findRepoRoot throws when no repository root is found', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'cli-common-workspaces-missing-'));
  try {
    let dir = tempRoot;
    for (let i = 0; i < 12; i++) {
      dir = join(dir, `d${i}`);
    }
    mkdirSync(dir, { recursive: true });
    assert.throws(() => findRepoRoot(dir), /Repository root not found starting from/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
