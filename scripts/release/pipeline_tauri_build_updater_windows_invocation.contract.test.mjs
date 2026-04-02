import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  resolveTauriPrepareBuildInvocation,
  resolveTauriCliInvocation,
} from '../pipeline/tauri/build-updater-artifacts.mjs';

test('Windows Tauri updater build uses npm run for tauri:prepare:build and tauri.cmd for tauri build', () => {
  const absUiDir = path.join('D:\\', 'a', 'happier', 'happier', 'apps', 'ui');

  const prepare = resolveTauriPrepareBuildInvocation({
    platform: 'win32',
    nodeExecPath: 'C:\\node.exe',
    npmExecPath: 'C:\\npm\\bin\\npm-cli.js',
  });

  assert.deepEqual(prepare, {
    cmd: 'C:\\node.exe',
    args: ['C:\\npm\\bin\\npm-cli.js', 'run', '-s', 'tauri:prepare:build'],
  });

  const tauri = resolveTauriCliInvocation({ platform: 'win32', absUiDir });
  assert.equal(tauri.cmd, path.win32.join(absUiDir, 'node_modules', '.bin', 'tauri.cmd'));
  assert.deepEqual(tauri.args, []);
});

