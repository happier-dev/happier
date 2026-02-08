import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildLaunchdPath, pickLaunchdProgramArgs } from './autostart_darwin.mjs';

function setEnvKey(t, key, value) {
  const previous = process.env[key];
  if (value == null) delete process.env[key];
  else process.env[key] = value;
  t.after(() => {
    if (previous == null) delete process.env[key];
    else process.env[key] = previous;
  });
}

test('buildLaunchdPath includes node dir and common tool paths', () => {
  const execPath = '/Users/me/.nvm/versions/node/v22.14.0/bin/node';
  const p = buildLaunchdPath({ execPath, basePath: '' });

  assert.ok(p.includes('/Users/me/.nvm/versions/node/v22.14.0/bin'), 'includes node dir');
  assert.ok(p.includes('/usr/bin'), 'includes /usr/bin');
  assert.ok(p.includes('/bin'), 'includes /bin');
});

test('pickLaunchdProgramArgs uses stable hstack shim when present', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-home-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const shim = join(dir, 'bin', 'hstack');
  await mkdir(join(dir, 'bin'), { recursive: true });
  await writeFile(shim, '#!/bin/sh\necho ok\n', { encoding: 'utf-8' });

  setEnvKey(t, 'HAPPIER_STACK_CANONICAL_HOME_DIR', dir);
  const args = pickLaunchdProgramArgs({ rootDir: '/fake/root' });
  assert.deepEqual(args, [shim, 'start']);
});

test('pickLaunchdProgramArgs falls back to node + hstack.mjs when shim missing', (t) => {
  setEnvKey(t, 'HAPPIER_STACK_CANONICAL_HOME_DIR', '/definitely-not-a-real-path');
  const execPath = '/usr/local/bin/node';
  const args = pickLaunchdProgramArgs({ rootDir: '/cli/root', execPath });
  assert.equal(args[0], execPath);
  assert.ok(String(args[1]).endsWith('/bin/hstack.mjs'));
  assert.equal(args[2], 'start');
});
