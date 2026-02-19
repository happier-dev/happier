import test from 'node:test';
import assert from 'node:assert/strict';

import { assertDockerCanRunLinuxAmd64 } from '../pipeline/docker/assert-docker-can-run-linux-amd64.mjs';

test('assertDockerCanRunLinuxAmd64 validates using a glibc-based amd64 image', () => {
  let called = false;
  assertDockerCanRunLinuxAmd64({
    exec: (cmd, args) => {
      called = true;
      assert.equal(cmd, 'docker');
      assert.deepEqual(args.slice(0, 5), ['run', '--rm', '--platform', 'linux/amd64', 'ubuntu:24.04']);
      return '';
    },
  });
  assert.equal(called, true);
});

test('assertDockerCanRunLinuxAmd64 throws a helpful hint when amd64 emulation is unavailable', () => {
  assert.throws(
    () => {
      assertDockerCanRunLinuxAmd64({
        exec: () => {
          const err = new Error('exec /usr/bin/bash: exec format error');
          // @ts-expect-error - node error shape
          err.stderr = 'exec /usr/bin/bash: exec format error';
          throw err;
        },
      });
    },
    (err) => {
      const msg = String(err?.message ?? err);
      assert.match(msg, /linux\/amd64/i);
      assert.match(msg, /docker/i);
      assert.match(msg, /exec format error/i);
      assert.match(msg, /rosetta|emulation|qemu/i);
      return true;
    },
  );
});
