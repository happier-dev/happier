import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runCommandLogged } from './progress.mjs';

test('runCommandLogged does not print progress when showSteps=false', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'happier-stack-progress-'));
  const logPath = join(dir, 'log.txt');

  const origWrite = process.stdout.write;
  let stdout = '';
  process.stdout.write = ((chunk, encoding, cb) => {
    stdout += typeof chunk === 'string' ? chunk : chunk.toString(typeof encoding === 'string' ? encoding : 'utf8');
    if (typeof cb === 'function') cb();
    return true;
  });

  try {
    const res = await runCommandLogged({
      label: 'noop',
      cmd: process.execPath,
      args: ['-e', "process.stdout.write('hello')"],
      cwd: process.cwd(),
      env: process.env,
      logPath,
      showSteps: false,
      quiet: true,
    });

    assert.equal(res.ok, true);
    assert.equal(stdout, '');

    const logged = await readFile(logPath, 'utf8');
    assert.ok(logged.includes('hello'));
  } finally {
    process.stdout.write = origWrite;
    await rm(dir, { recursive: true, force: true });
  }
});

