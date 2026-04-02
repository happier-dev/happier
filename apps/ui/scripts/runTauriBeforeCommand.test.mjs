import test from 'node:test';
import assert from 'node:assert/strict';

import { runTauriBeforeCommand } from './runTauriBeforeCommand.mjs';

test('runTauriBeforeCommand runs yarn prepare:build via cmd on Windows', () => {
  /** @type {any} */
  let call = null;
  runTauriBeforeCommand({
    mode: 'build',
    platform: 'win32',
    cwd: 'C:\\repo\\apps\\ui',
    env: { PATH: 'x' },
    execFileSync: (cmd, args, opts) => {
      call = { cmd, args, opts };
      return Buffer.from('');
    },
  });

  assert.equal(call.cmd, 'cmd');
  assert.deepEqual(call.args.slice(0, 3), ['/D', '/S', '/C']);
  assert.equal(call.args[3], 'yarn -s tauri:prepare:build');
  assert.equal(call.opts.cwd, 'C:\\repo\\apps\\ui');
});

test('runTauriBeforeCommand runs yarn prepare:dev via bash on macOS/Linux', () => {
  /** @type {any} */
  let call = null;
  runTauriBeforeCommand({
    mode: 'dev',
    platform: 'darwin',
    cwd: '/repo/apps/ui',
    env: { PATH: 'x' },
    execFileSync: (cmd, args, opts) => {
      call = { cmd, args, opts };
      return Buffer.from('');
    },
  });

  assert.equal(call.cmd, 'bash');
  assert.deepEqual(call.args, ['-lc', 'yarn -s tauri:prepare:dev']);
  assert.equal(call.opts.cwd, '/repo/apps/ui');
});

test('runTauriBeforeCommand rejects unknown mode', () => {
  assert.throws(() => {
    runTauriBeforeCommand({
      // @ts-expect-error - intentional invalid input for test
      mode: 'nope',
      platform: 'darwin',
      cwd: '/repo/apps/ui',
      env: { PATH: 'x' },
      execFileSync: () => Buffer.from(''),
    });
  }, /mode must be 'dev' or 'build'/);
});

