import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

describe('resolveWindowsCommandInvocation', () => {
  const tempDirs = new Set<string>();

  afterEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  it('prefers PATHEXT-resolved commands over extensionless files when both exist on PATH', async () => {
    if (!originalPlatformDescriptor) {
      throw new Error('Expected process.platform to be configurable for this test');
    }
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });

    const root = mkdtempSync(join(tmpdir(), 'happier-cli-common-win32-path-'));
    tempDirs.add(root);
    const binDir = join(root, 'bin');
    mkdirSync(binDir, { recursive: true });

    const extensionlessPath = join(binDir, 'codex');
    const cmdShimPath = join(binDir, 'codex.cmd');
    writeFileSync(extensionlessPath, '', 'utf8');
    writeFileSync(cmdShimPath, '@echo off\r\necho ok\r\n', 'utf8');

    const { resolveWindowsCommandOnPath } = await import('./resolveWindowsCommandInvocation.js');

    expect(resolveWindowsCommandOnPath('codex', {
      PATH: binDir,
      PATHEXT: '.CMD;.EXE',
    })?.toLowerCase()).toBe(cmdShimPath.toLowerCase());
  });

  it('normalizes full command paths without an extension to the matching .cmd shim', async () => {
    if (!originalPlatformDescriptor) {
      throw new Error('Expected process.platform to be configurable for this test');
    }
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });

    const root = mkdtempSync(join(tmpdir(), 'happier-cli-common-win32-invocation-'));
    tempDirs.add(root);
    const binDir = join(root, 'bin');
    mkdirSync(binDir, { recursive: true });

    const extensionlessPath = join(binDir, 'codex');
    const cmdShimPath = join(binDir, 'codex.cmd');
    writeFileSync(extensionlessPath, '', 'utf8');
    writeFileSync(cmdShimPath, '@echo off\r\necho ok\r\n', 'utf8');

    const { resolveWindowsCommandInvocation } = await import('./resolveWindowsCommandInvocation.js');

    const invocation = resolveWindowsCommandInvocation({
      command: extensionlessPath,
      args: ['app-server'],
      env: {
        PATH: binDir,
        PATHEXT: '.CMD;.EXE',
      },
    });

    expect(invocation.command).toBe('cmd.exe');
    expect(invocation.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(invocation.args[3]?.toLowerCase()).toContain(cmdShimPath.toLowerCase());
    expect(invocation.windowsVerbatimArguments).toBe(true);
  });

  it('resolves cmd.exe through COMSPEC when the command is not available on PATH', async () => {
    if (!originalPlatformDescriptor) {
      throw new Error('Expected process.platform to be configurable for this test');
    }
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });

    const { resolveWindowsCommandInvocation } = await import('./resolveWindowsCommandInvocation.js');

    const invocation = resolveWindowsCommandInvocation({
      command: 'cmd.exe',
      args: ['/c', 'npm install -g opencode-ai'],
      env: {
        PATH: '',
        PATHEXT: '.EXE;.CMD;.BAT;.COM',
        COMSPEC: 'C:\\WINDOWS\\system32\\cmd.exe',
      },
    });

    expect(invocation).toEqual({
      command: 'C:\\WINDOWS\\system32\\cmd.exe',
      args: ['/c', 'npm install -g opencode-ai'],
    });
  });
});
