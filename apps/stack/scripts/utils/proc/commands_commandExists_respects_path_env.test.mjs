import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { commandExists } from './commands.mjs';

test('commandExists respects provided PATH env (no login-shell PATH clobber)', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-commands-path-'));
  try {
    const binDir = join(tmp, 'bin');
    await mkdir(binDir, { recursive: true });
    const stub = join(binDir, 'hstack-test-binary');
    await writeFile(stub, '#!/bin/bash\nexit 0\n', 'utf-8');
    if (process.platform !== 'win32') {
      await chmod(stub, 0o755);
    }

    const env = { ...process.env, PATH: binDir };
    assert.equal(await commandExists('hstack-test-binary', { env, cwd: tmp, timeoutMs: 5_000 }), true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
