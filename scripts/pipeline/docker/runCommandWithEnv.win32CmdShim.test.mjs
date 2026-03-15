import test from 'node:test';
import assert from 'node:assert/strict';

import { runCommandWithEnv } from './runCommandWithEnv.mjs';

test('runCommandWithEnv wraps .cmd commands with cmd.exe on Windows', () => {
  /** @type {Array<{ cmd: string; args: string[]; opts: any }>} */
  const calls = [];

  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    runCommandWithEnv({
      cmd: 'C:\\repo\\node_modules\\.bin\\sentry-cli.cmd',
      args: ['releases', 'new', '1.2.3'],
      env: {
        ...process.env,
        ComSpec: 'C:\\\\Windows\\\\System32\\\\cmd.exe',
      },
      stdio: 'inherit',
      execFileSync: (cmd, args, opts) => {
        calls.push({ cmd, args, opts });
        return Buffer.from('');
      },
    });
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'C:\\\\Windows\\\\System32\\\\cmd.exe');
  assert.deepEqual(calls[0].args.slice(0, 3), ['/d', '/s', '/c']);
  assert.match(String(calls[0].args[3] ?? ''), /sentry-cli\.cmd/i);
  assert.equal(calls[0].opts?.windowsVerbatimArguments, true);
});
