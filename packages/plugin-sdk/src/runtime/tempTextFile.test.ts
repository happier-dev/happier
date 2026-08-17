import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  writeSecureTempTextFileSync,
  writeSecureTempTextFileSyncWithDeps,
} from './tempTextFile.js';
import type { WindowsProtectedAclBoundarySync } from '@happier-dev/cli-common/fs/windowsProtectedAcl';

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe('writeSecureTempTextFileSync', () => {
  it('writes text into a private unique temp directory with restrictive permissions', () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-plugin-sdk-temp-text-'));

    try {
      const path = writeSecureTempTextFileSync({
        tmpDir: root,
        prefix: 'happier-kimi-readonly-agent',
        suffix: '.yaml',
        contents: 'version: 1\n',
      });

      expect(readFileSync(path, 'utf8')).toBe('version: 1\n');
      expect(dirname(path)).not.toBe(root);
      expect(basename(path)).toBe('payload.yaml');
      if (process.platform !== 'win32') {
        expect(mode(dirname(path))).toBe(0o700);
        expect(mode(path)).toBe(0o600);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not chmod the caller-provided temp root', () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-plugin-sdk-temp-text-root-'));

    try {
      if (process.platform !== 'win32') {
        rmSync(root, { recursive: true, force: true });
        mkdirSync(root, { mode: 0o755 });
      }

      const beforeMode = process.platform === 'win32' ? null : mode(root);
      const path = writeSecureTempTextFileSync({
        tmpDir: root,
        prefix: 'safe-root',
        contents: 'payload',
      });

      expect(readFileSync(path, 'utf8')).toBe('payload');
      if (process.platform !== 'win32') {
        expect(mode(root)).toBe(beforeMode);
        expect(mode(dirname(path))).toBe(0o700);
        expect(mode(path)).toBe(0o600);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects path-like prefixes and suffixes', () => {
    expect(() => writeSecureTempTextFileSync({
      prefix: '../escape',
      contents: 'nope',
    })).toThrow(/prefix/);
    expect(() => writeSecureTempTextFileSync({
      prefix: 'safe',
      suffix: '/escape',
      contents: 'nope',
    })).toThrow(/suffix/);
  });

  it('fails closed unless Windows directory and file ACLs are applied before writing', () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-plugin-sdk-temp-text-windows-'));
    let protectedFileWasEmpty = false;
    const windowsAclBoundary: WindowsProtectedAclBoundarySync = {
      applyAndVerify: vi.fn(({ path, kind }) => {
        if (kind === 'file') protectedFileWasEmpty = readFileSync(path, 'utf8') === '';
      }),
      verify: vi.fn(),
    };

    try {
      const path = writeSecureTempTextFileSyncWithDeps({
        tmpDir: root,
        prefix: 'happier-claude-mcp-config',
        suffix: '.json',
        contents: '{"token":"synthetic-windows-acl-marker"}',
      }, { platform: 'win32', windowsAclBoundary });

      expect(protectedFileWasEmpty).toBe(true);
      expect(windowsAclBoundary.applyAndVerify).toHaveBeenCalledWith({ path: dirname(path), kind: 'directory' });
      expect(windowsAclBoundary.applyAndVerify).toHaveBeenCalledWith({ path, kind: 'file' });
      expect(windowsAclBoundary.verify).toHaveBeenCalledWith({ path, kind: 'file' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    const rejectingRoot = mkdtempSync(join(tmpdir(), 'happier-plugin-sdk-temp-text-reject-'));
    try {
      expect(() => writeSecureTempTextFileSyncWithDeps({
        tmpDir: rejectingRoot,
        prefix: 'happier-claude-mcp-config',
        suffix: '.json',
        contents: '{"token":"synthetic-rejected-acl-marker"}',
      }, {
        platform: 'win32',
        windowsAclBoundary: {
          applyAndVerify() { throw new Error('synthetic ACL rejection'); },
          verify() {},
        },
      })).toThrow('synthetic ACL rejection');
      expect(readdirSync(rejectingRoot)).toEqual([]);
    } finally {
      rmSync(rejectingRoot, { recursive: true, force: true });
    }
  });
});
