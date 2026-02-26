import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveCommandInvocation } from './resolveCommandInvocation.mjs';

test('resolveCommandInvocation wraps .cmd commands with cmd.exe on Windows', async () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(originalPlatformDescriptor, 'expected process.platform descriptor');

  const temp = await mkdtemp(join(tmpdir(), 'hstack-win32-invocation-'));
  try {
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });

    const npmCmd = join(temp, 'npm.CMD');
    await writeFile(npmCmd, '@echo off\r\necho ok\r\n', 'utf8');

    const invocation = resolveCommandInvocation({
      command: 'npm',
      args: ['--version'],
      env: { ...process.env, PATH: temp, PATHEXT: '.CMD' },
    });

    assert.equal(invocation.command, 'cmd.exe');
    assert.deepEqual(invocation.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.ok(String(invocation.args[3]).includes('npm.CMD'));
    assert.equal(invocation.windowsVerbatimArguments, true);
  } finally {
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    await rm(temp, { recursive: true, force: true });
  }
});

