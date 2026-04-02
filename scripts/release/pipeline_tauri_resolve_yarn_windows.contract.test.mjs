import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveYarnInvocation } from '../pipeline/tauri/resolve-yarn-invocation.mjs';

test('resolveYarnInvocation prefers the corepack-installed yarn.cmd shim next to node.exe on Windows', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-tauri-yarn-invocation-'));
  const yarnCmd = path.join(tmp, 'yarn.cmd');
  fs.writeFileSync(yarnCmd, '@echo off\r\nexit /b 0\r\n', 'utf8');

  const yarn = resolveYarnInvocation({
    platform: 'win32',
    nodeExecPath: path.join(tmp, 'node.exe'),
    execFileSync: () => {
      throw new Error('unexpected execFileSync call');
    },
  });

  assert.deepEqual(yarn, { cmd: yarnCmd, prefixArgs: [] });
});

test('resolveYarnInvocation prefers yarn.cmd on Windows when yarn is available in a cmd shell', () => {
  const yarn = resolveYarnInvocation({
    platform: 'win32',
    execFileSync: (cmd, args, opts) => {
      void opts;
      if (cmd !== 'cmd.exe') throw new Error(`unexpected exec: ${cmd}`);
      assert.deepEqual(args, ['/D', '/S', '/C', 'yarn --version']);
      return '1.22.22\n';
    },
  });

  assert.deepEqual(yarn, { cmd: 'yarn.cmd', prefixArgs: [] });
});
