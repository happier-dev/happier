import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { readDevReloadWatchChangeSignature } from './watchSignature.mjs';

test('readDevReloadWatchChangeSignature changes when a watched file changes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-watch-signature-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const srcDir = join(root, 'src');
  const watchedFile = join(srcDir, 'index.ts');
  await mkdir(srcDir, { recursive: true });
  await writeFile(watchedFile, 'export const value = 1;\n', 'utf-8');

  const before = readDevReloadWatchChangeSignature([srcDir]);
  await writeFile(watchedFile, 'export const value = 12345;\n', 'utf-8');
  const after = readDevReloadWatchChangeSignature([srcDir]);

  assert.equal(typeof before, 'string');
  assert.equal(typeof after, 'string');
  assert.notEqual(after, before);
});

test('readDevReloadWatchChangeSignature returns null when no path is observable', () => {
  const signature = readDevReloadWatchChangeSignature(['/tmp/hstack-missing-watch-path-for-test']);
  assert.equal(signature, null);
});
