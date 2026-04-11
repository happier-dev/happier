import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  resolveWindowsCommandInvocation,
  resolveWindowsCommandOnPath,
} from './resolveWindowsCommandInvocation.mjs';

test('resolveWindowsCommandOnPath prefers PATHEXT shims over extensionless files', () => {
  const root = mkdtempSync(join(tmpdir(), 'happier-pipeline-win32-path-'));
  try {
    const binDir = join(root, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'happier'), '', 'utf8');
    const cmdShimPath = join(binDir, 'happier.cmd');
    writeFileSync(cmdShimPath, '@echo off\r\necho ok\r\n', 'utf8');

    const resolved = resolveWindowsCommandOnPath('happier', {
      PATH: binDir,
      PATHEXT: '.CMD;.EXE',
    });

    assert.equal(resolved?.toLowerCase(), cmdShimPath.toLowerCase());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveWindowsCommandInvocation normalizes explicit extensionless command paths to .cmd shims', () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const root = mkdtempSync(join(tmpdir(), 'happier-pipeline-win32-invocation-'));
  try {
    if (!originalPlatformDescriptor) {
      throw new Error('Expected process.platform to be configurable for this test');
    }
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });

    const binDir = join(root, 'bin');
    mkdirSync(binDir, { recursive: true });
    const extensionlessPath = join(binDir, 'happier');
    const cmdShimPath = join(binDir, 'happier.cmd');
    writeFileSync(extensionlessPath, '', 'utf8');
    writeFileSync(cmdShimPath, '@echo off\r\necho ok\r\n', 'utf8');

    const invocation = resolveWindowsCommandInvocation({
      command: extensionlessPath,
      args: ['doctor'],
      env: {
        PATH: binDir,
        PATHEXT: '.CMD;.EXE',
      },
    });

    assert.equal(invocation.command, 'cmd.exe');
    assert.deepEqual(invocation.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.match(invocation.args[3] ?? '', new RegExp(cmdShimPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    assert.equal(invocation.windowsVerbatimArguments, true);
  } finally {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
    rmSync(root, { recursive: true, force: true });
  }
});
