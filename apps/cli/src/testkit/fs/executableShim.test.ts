import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

describe('executable shim helpers', () => {
  it('creates an executable shim file', async () => {
    const shims = await import('@/testkit/fs/executableShim').catch(() => null);

    expect(shims).not.toBeNull();
    expect(shims?.createExecutableShim).toBeTypeOf('function');

    const filePath = await shims!.createExecutableShim({
      dirPrefix: 'happier-cli-testkit-shim-',
      fileName: 'shim.sh',
      contents: '#!/bin/sh\nexit 0\n',
    });

    await expect(access(filePath)).resolves.toBeUndefined();
    const contents = await readFile(filePath, 'utf8');
    expect(contents).toContain('exit 0');
    const fileStat = await stat(filePath);
    expect(fileStat.isFile()).toBe(true);
    if (process.platform !== 'win32') {
      expect(fileStat.mode & 0o111).not.toBe(0);
    }
  });

  it('writes an executable shim into an existing directory', async () => {
    const shims = await import('@/testkit/fs/executableShim').catch(() => null);

    expect(shims).not.toBeNull();
    expect(shims?.writeExecutableShimSync).toBeTypeOf('function');

    const dir = await mkdtemp(join(tmpdir(), 'happier-cli-testkit-existing-shim-'));
    try {
      const filePath = shims!.writeExecutableShimSync({
        dir,
        fileName: process.platform === 'win32' ? 'shim.cmd' : 'shim.sh',
        contents: process.platform === 'win32' ? '@echo off\r\necho ok\r\n' : '#!/bin/sh\necho ok\n',
      });

      expect(filePath).toBe(join(dir, process.platform === 'win32' ? 'shim.cmd' : 'shim.sh'));
      await expect(access(filePath)).resolves.toBeUndefined();
      const contents = await readFile(filePath, 'utf8');
      expect(contents).toContain('echo ok');
      const fileStat = await stat(filePath);
      expect(fileStat.isFile()).toBe(true);
      if (process.platform !== 'win32') {
        expect(fileStat.mode & 0o111).not.toBe(0);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('resolves a system JavaScript runtime binary for bridge helpers', async () => {
    const shims = await import('@/testkit/fs/executableShim').catch(() => null);

    expect(shims).not.toBeNull();
    expect(shims?.resolveSystemJavaScriptRuntimeBinary).toBeTypeOf('function');

    const runtimeBinary = shims!.resolveSystemJavaScriptRuntimeBinary(process.env.PATH);

    expect(runtimeBinary).toBeTruthy();
    await expect(access(runtimeBinary)).resolves.toBeUndefined();
  });

  it('writes a pnpm node bridge into an existing directory', async () => {
    const shims = await import('@/testkit/fs/executableShim').catch(() => null);

    expect(shims).not.toBeNull();
    expect(shims?.writePnpmNodeBridge).toBeTypeOf('function');

    const dir = await mkdtemp(join(tmpdir(), 'happier-cli-testkit-pnpm-bridge-'));
    try {
      const filePath = await shims!.writePnpmNodeBridge({
        dir,
        pathLookup: process.env.PATH,
      });

      expect(filePath).toBe(join(dir, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'));
      await expect(access(filePath)).resolves.toBeUndefined();
      const contents = await readFile(filePath, 'utf8');
      expect(contents).toContain('node');
      const fileStat = await stat(filePath);
      expect(fileStat.isFile()).toBe(true);
      if (process.platform !== 'win32') {
        expect(fileStat.mode & 0o111).not.toBe(0);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
