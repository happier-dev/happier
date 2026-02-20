import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ensureTauriSigningKeyFile } from '../pipeline/tauri/ensure-signing-key-file.mjs';

test('ensureTauriSigningKeyFile materializes inline key contents to a temp file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'happier-tauri-key-'));
  const tmpRoot = path.join(dir, 'tmp');
  const key = 'untrusted comment: tauri signing key\\nRWabc123\\n';

  const outPath = await ensureTauriSigningKeyFile({ tmpRoot, keyValue: key, dryRun: false });
  assert.ok(outPath.includes('tauri.signing.key'), 'expected a stable signing key filename');

  const contents = await readFile(outPath, 'utf8');
  assert.equal(contents, 'untrusted comment: tauri signing key\nRWabc123\n');
});

test('ensureTauriSigningKeyFile returns the path unchanged when keyValue is an existing file path', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'happier-tauri-key-path-'));
  const keyPath = path.join(dir, 'key.txt');
  await writeFile(keyPath, 'hello\n', 'utf8');

  const outPath = await ensureTauriSigningKeyFile({ tmpRoot: dir, keyValue: keyPath, dryRun: false });
  assert.equal(outPath, keyPath);
});

test('ensureTauriSigningKeyFile supports dry-run without writing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'happier-tauri-key-dry-'));
  const tmpRoot = path.join(dir, 'tmp');
  const outPath = await ensureTauriSigningKeyFile({ tmpRoot, keyValue: 'RWabc123', dryRun: true });
  assert.ok(outPath.includes('tauri.signing.key'), 'expected a stable signing key filename');
});

