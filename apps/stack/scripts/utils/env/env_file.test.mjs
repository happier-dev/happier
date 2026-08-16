import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  compareAndSetEnvFileValue,
  createEnvFileExclusive,
  ensureEnvFilePruned,
  ensureEnvFileUpdated,
} from './env_file.mjs';

async function withTempRoot(t) {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-env-file-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('ensureEnvFileUpdated appends new key and ensures trailing newline', async (t) => {
  const dir = await withTempRoot(t);
  const envPath = join(dir, 'env');

  await ensureEnvFileUpdated({ envPath, updates: [{ key: 'OPENAI_API_KEY', value: 'sk-test' }] });
  const next = await readFile(envPath, 'utf-8');
  assert.equal(next, 'OPENAI_API_KEY=sk-test\n');
});

test('createEnvFileExclusive permits exactly one concurrent creator', async (t) => {
  const dir = await withTempRoot(t);
  const envPath = join(dir, 'env');

  const results = await Promise.all([
    createEnvFileExclusive({ envPath, content: 'CREATOR=first\n' }),
    createEnvFileExclusive({ envPath, content: 'CREATOR=second\n' }),
  ]);

  assert.deepEqual(results.toSorted(), [false, true]);
  assert.match(await readFile(envPath, 'utf-8'), /^CREATOR=(first|second)\n$/);
});

test('createEnvFileExclusive preserves an existing env byte-for-byte', async (t) => {
  const dir = await withTempRoot(t);
  const envPath = join(dir, 'env');
  const existing = 'SENTINEL=preserve-me\nHAPPIER_STACK_RUNTIME_MODE=require\n';
  await writeFile(envPath, existing, 'utf-8');

  assert.equal(await createEnvFileExclusive({ envPath, content: 'REPLACEMENT=forbidden\n' }), false);
  assert.equal(await readFile(envPath, 'utf-8'), existing);
});

test('ensureEnvFileUpdated does not touch file when no content changes', async (t) => {
  const dir = await withTempRoot(t);
  const envPath = join(dir, 'env');

  await writeFile(envPath, 'FOO=bar\n', 'utf-8');
  const oldTime = new Date('2001-01-01T00:00:00.000Z');
  await utimes(envPath, oldTime, oldTime);
  const before = await stat(envPath);

  await ensureEnvFileUpdated({ envPath, updates: [{ key: 'FOO', value: 'bar' }] });
  const after = await stat(envPath);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test('ensureEnvFilePruned removes a key but keeps comments/blank lines', async (t) => {
  const dir = await withTempRoot(t);
  const envPath = join(dir, 'env');

  await writeFile(envPath, '# header\nFOO=bar\n\nBAZ=qux\n', 'utf-8');
  await ensureEnvFilePruned({ envPath, removeKeys: ['FOO'] });

  const next = await readFile(envPath, 'utf-8');
  assert.equal(next, '# header\n\nBAZ=qux\n');
});

test('compareAndSetEnvFileValue preserves a successor value and unrelated edits', async (t) => {
  const dir = await withTempRoot(t);
  const envPath = join(dir, 'env');
  await writeFile(envPath, 'EXPO_PORT=8081\nOTHER=before\n', 'utf-8');
  await ensureEnvFileUpdated({
    envPath,
    updates: [{ key: 'EXPO_PORT', value: '9090' }, { key: 'CONCURRENT', value: 'kept' }],
  });
  assert.equal(await compareAndSetEnvFileValue({
    envPath,
    key: 'EXPO_PORT',
    expectedValue: '8081',
    nextValue: null,
  }), false);
  assert.equal(await readFile(envPath, 'utf-8'), 'EXPO_PORT=9090\nOTHER=before\n\nCONCURRENT=kept\n');
});
