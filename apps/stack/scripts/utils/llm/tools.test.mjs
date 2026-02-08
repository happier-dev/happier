import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectInstalledLlmTools } from './tools.mjs';

async function writeStubCmd(binDir, name) {
  const p = join(binDir, name);
  await writeFile(p, ['#!/usr/bin/env bash', 'exit 0'].join('\n') + '\n', 'utf-8');
  await chmod(p, 0o755);
  return p;
}

function withPatchedPath(t, value) {
  const prevPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = prevPath;
  });
  process.env.PATH = value;
}

test('detectInstalledLlmTools finds tools on PATH and filters onlyAutoExec', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-llm-tools-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const binDir = join(root, 'bin');
  await mkdir(binDir, { recursive: true });

  await writeStubCmd(binDir, 'codex');
  await writeStubCmd(binDir, 'claude');

  withPatchedPath(t, `${binDir}:${process.env.PATH ?? ''}`);

  const all = await detectInstalledLlmTools();
  assert.ok(all.some((t) => t.id === 'codex'));
  assert.ok(all.some((t) => t.id === 'claude'));

  const auto = await detectInstalledLlmTools({ onlyAutoExec: true });
  assert.deepEqual(
    auto.map((t) => t.id),
    ['codex']
  );
});

test('detectInstalledLlmTools returns empty list when PATH is blank', async (t) => {
  withPatchedPath(t, '');
  const all = await detectInstalledLlmTools();
  assert.deepEqual(all, []);
});

test('detectInstalledLlmTools onlyAutoExec excludes non-auto tools even when present', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-llm-tools-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const binDir = join(root, 'bin');
  await mkdir(binDir, { recursive: true });
  await writeStubCmd(binDir, 'claude');

  withPatchedPath(t, binDir);
  const auto = await detectInstalledLlmTools({ onlyAutoExec: true });
  assert.deepEqual(auto, []);
});
