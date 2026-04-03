import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveYarnInvocation } from '../pipeline/tauri/resolve-yarn-invocation.mjs';

test('resolveYarnInvocation prefers a non-corepack Yarn resolved via cmd.exe `where` on Windows', () => {
  const nodeExecPath = 'C:\\hostedtoolcache\\windows\\node\\22.22.1\\x64\\node.exe';

  const yarn = resolveYarnInvocation({
    platform: 'win32',
    nodeExecPath,
    execFileSync: (cmd, args, opts) => {
      void opts;
      if (cmd !== 'cmd.exe') throw new Error(`unexpected exec: ${cmd}`);

      assert.deepEqual(args, ['/D', '/S', '/C', 'where yarn']);
      return [
        // Corepack shim next to node.exe (broken on some runners).
        'C:\\hostedtoolcache\\windows\\node\\22.22.1\\x64\\yarn.cmd',
        // Global Yarn (expected to work).
        'C:\\npm\\prefix\\yarn.cmd',
        '',
      ].join('\r\n');
    },
  });

  assert.deepEqual(yarn, { cmd: 'C:\\npm\\prefix\\yarn.cmd', prefixArgs: [] });
});

test('resolveYarnInvocation can use a yarn.cmd shim next to node.exe on Windows when it runs successfully', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-tauri-yarn-invocation-'));
  const yarnCmd = path.join(tmp, 'yarn.cmd');
  fs.writeFileSync(yarnCmd, '@echo off\r\nexit /b 0\r\n', 'utf8');

  const yarn = resolveYarnInvocation({
    platform: 'win32',
    nodeExecPath: path.join(tmp, 'node.exe'),
    execFileSync: (cmd, args, opts) => {
      void opts;
      if (cmd !== 'cmd.exe') throw new Error(`unexpected exec: ${cmd}`);
      if (args[3] === 'where yarn') return '';

      // Prove the node-adjacent shim is runnable.
      assert.deepEqual(args, ['/D', '/S', '/C', `"${yarnCmd}" --version`]);
      return '1.22.22\r\n';
    },
  });

  assert.deepEqual(yarn, { cmd: yarnCmd, prefixArgs: [] });
});

test('resolveYarnInvocation skips a broken node-adjacent yarn.cmd and falls back to PATH yarn.cmd', () => {
  const nodeExecPath = 'C:\\hostedtoolcache\\windows\\node\\22.22.1\\x64\\node.exe';
  const nodeDirYarn = 'C:\\hostedtoolcache\\windows\\node\\22.22.1\\x64\\yarn.cmd';

  const yarn = resolveYarnInvocation({
    platform: 'win32',
    nodeExecPath,
    execFileSync: (cmd, args, opts) => {
      void opts;
      if (cmd !== 'cmd.exe') throw new Error(`unexpected exec: ${cmd}`);
      if (args[3] === 'where yarn') {
        // Only the node-adjacent shim is visible.
        return `${nodeDirYarn}\r\n`;
      }

      // Probe the node-adjacent shim: it fails.
      if (args[3] === `"${nodeDirYarn}" --version`) {
        throw new Error('spawn yarn ENOENT');
      }

      // PATH yarn works (for example global Yarn installed by setup-node).
      assert.deepEqual(args, ['/D', '/S', '/C', 'yarn --version']);
      return '1.22.22\r\n';
    },
  });

  assert.deepEqual(yarn, { cmd: 'yarn.cmd', prefixArgs: [] });
});

test('resolveYarnInvocation prefers yarn.cmd on Windows when yarn is available in a cmd shell', () => {
  const yarn = resolveYarnInvocation({
    platform: 'win32',
    execFileSync: (cmd, args, opts) => {
      void opts;
      if (cmd !== 'cmd.exe') throw new Error(`unexpected exec: ${cmd}`);
      if (args[3] === 'where yarn') return '';
      assert.deepEqual(args, ['/D', '/S', '/C', 'yarn --version']);
      return '1.22.22\r\n';
    },
  });

  assert.deepEqual(yarn, { cmd: 'yarn.cmd', prefixArgs: [] });
});
