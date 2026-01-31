import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { ensureEnvFilePruned, ensureEnvFileUpdated } from './env_file.mjs';

test('ensureEnvFileUpdated appends new key and ensures trailing newline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-env-file-'));
  const envPath = join(dir, 'env');

  await ensureEnvFileUpdated({ envPath, updates: [{ key: 'OPENAI_API_KEY', value: 'sk-test' }] });
  const next = await readFile(envPath, 'utf-8');
  assert.equal(next, 'OPENAI_API_KEY=sk-test\n');
});

test('ensureEnvFileUpdated does not touch file when no content changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-env-file-'));
  const envPath = join(dir, 'env');

  await writeFile(envPath, 'FOO=bar\n', 'utf-8');
  const before = await stat(envPath);

  // Ensure filesystem mtime resolution won't hide unintended writes.
  await delay(25);

  await ensureEnvFileUpdated({ envPath, updates: [{ key: 'FOO', value: 'bar' }] });
  const after = await stat(envPath);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test('ensureEnvFilePruned removes a key but keeps comments/blank lines', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-env-file-'));
  const envPath = join(dir, 'env');

  await writeFile(envPath, '# header\nFOO=bar\n\nBAZ=qux\n', 'utf-8');
  await ensureEnvFilePruned({ envPath, removeKeys: ['FOO'] });

  const next = await readFile(envPath, 'utf-8');
  assert.equal(next, '# header\n\nBAZ=qux\n');
});

