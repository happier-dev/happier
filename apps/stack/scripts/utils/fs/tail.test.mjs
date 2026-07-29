import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readLastLinesAfterProcessCompletion } from './tail.mjs';

test('guided-auth tail waits for process completion before reading the final tee line', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-guided-auth-tail-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const logPath = join(root, 'expo.log');
  await writeFile(logPath, '[expo] early line\n', 'utf-8');
  let releaseCompletion;
  const proc = {
    completion: new Promise((resolve) => {
      releaseCompletion = resolve;
    }),
  };
  let settled = false;
  const pending = readLastLinesAfterProcessCompletion(proc, logPath, 80).then((tail) => {
    settled = true;
    return tail;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'guided-auth diagnostics must not read while the tee can still append');
  await appendFile(logPath, '[expo] final line after child exit\n', 'utf-8');
  releaseCompletion({ code: 1, signal: null });

  assert.match(await pending, /final line after child exit/);
});
