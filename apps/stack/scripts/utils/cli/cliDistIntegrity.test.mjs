import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  findMissingCliDistModules,
  readCliDistClosureFingerprint,
} from './cliDistIntegrity.mjs';

test('findMissingCliDistModules ignores unreachable stale modules', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-cli-dist-integrity-'));
  try {
    const distDir = join(tmp, 'dist');
    const entrypoint = join(distDir, 'index.mjs');
    await mkdir(distDir, { recursive: true });
    await writeFile(entrypoint, "import './used.mjs';\n", 'utf-8');
    await writeFile(join(distDir, 'used.mjs'), 'export const ready = true;\n', 'utf-8');
    await writeFile(join(distDir, 'stale-unused.mjs'), "import './missing-old.mjs';\n", 'utf-8');

    assert.deepEqual(findMissingCliDistModules(entrypoint), []);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('readCliDistClosureFingerprint hashes only the reachable entrypoint closure', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'happy-cli-dist-fingerprint-'));
  try {
    const distDir = join(tmp, 'dist');
    const entrypoint = join(distDir, 'index.mjs');
    const staleUnusedPath = join(distDir, 'stale-unused.mjs');
    await mkdir(distDir, { recursive: true });
    await writeFile(entrypoint, "import './used.mjs';\n", 'utf-8');
    await writeFile(join(distDir, 'used.mjs'), 'export const value = 1;\n', 'utf-8');
    await writeFile(staleUnusedPath, 'export const stale = 1;\n', 'utf-8');

    const first = readCliDistClosureFingerprint(entrypoint);
    assert.equal(first.ok, true);
    assert.equal(first.fileCount, 2);
    assert.ok(first.fingerprint, 'expected a fingerprint for the reachable closure');

    await writeFile(staleUnusedPath, 'export const stale = 2;\n', 'utf-8');

    const second = readCliDistClosureFingerprint(entrypoint);
    assert.equal(second.ok, true);
    assert.equal(second.fileCount, 2);
    assert.equal(second.fingerprint, first.fingerprint);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
