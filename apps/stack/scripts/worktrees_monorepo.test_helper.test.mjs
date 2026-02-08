import test from 'node:test';
import assert from 'node:assert/strict';

import { runNode } from './worktrees_monorepo.test_helper.mjs';

test('runNode reports non-zero exit code for signal-terminated process', async () => {
  const res = await runNode(['-e', 'process.kill(process.pid, "SIGTERM")'], {
    cwd: process.cwd(),
    env: process.env,
  });

  assert.equal(res.code, 1);
  assert.match(res.stderr, /signal/i);
});

test('runNode waits for stdio streams to flush before resolving', async () => {
  const size = 200_000;
  const res = await runNode(
    ['-e', `process.stdout.write("A".repeat(${size})); process.stderr.write("B".repeat(${size}));`],
    {
      cwd: process.cwd(),
      env: process.env,
    }
  );

  assert.equal(res.code, 0);
  assert.equal(res.stdout.length, size);
  assert.equal(res.stderr.length, size);
});
