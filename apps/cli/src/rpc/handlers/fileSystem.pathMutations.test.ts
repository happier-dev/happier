import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { statSync } from 'node:fs';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerFileSystemHandlers } from './fileSystem';

type Handler = (data: any) => Promise<any>;

afterEach(() => {
  vi.doUnmock('fs/promises');
  vi.resetModules();
});

function createRpcHandlerManager(): { handlers: Map<string, Handler>; registerHandler: (method: string, handler: Handler) => void } {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    registerHandler(method, handler) {
      handlers.set(method, handler);
    },
  };
}

describe('filesystem path mutations', () => {
  it('statFile returns exists=false for missing paths', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-stat-'));
    try {
      const mgr = createRpcHandlerManager();
      registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, workspace);

      const statFile = mgr.handlers.get(RPC_METHODS.STAT_FILE);
      if (!statFile) throw new Error('expected statFile handler');

      const result = await statFile({ path: 'missing.txt' });
      expect(result).toMatchObject({ success: true, exists: false });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('statFile returns file metadata for existing files', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-stat-'));
    try {
      writeFileSync(join(workspace, 'file.txt'), 'hello\n', 'utf8');

      const mgr = createRpcHandlerManager();
      registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, workspace);

      const statFile = mgr.handlers.get(RPC_METHODS.STAT_FILE);
      if (!statFile) throw new Error('expected statFile handler');

      const result = await statFile({ path: 'file.txt' });
      expect(result).toMatchObject({ success: true, exists: true, kind: 'file' });
      expect(typeof result.sizeBytes).toBe('number');
      expect(typeof result.modifiedMs).toBe('number');
      expect(result.contentHash).toBeUndefined();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('statFile preserves high-precision mtime for snapshot revision consumers', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-stat-'));
    try {
      writeFileSync(join(workspace, 'file.txt'), 'hello\n', 'utf8');
      const statMock = vi.fn(async () => ({
        isDirectory: () => false,
        isFile: () => true,
        size: 5,
        mtime: new Date(100),
        mtimeMs: 100.125,
      }));
      vi.resetModules();
      vi.doMock('fs/promises', async (importOriginal) => {
        const original = await importOriginal<typeof import('fs/promises')>();
        return { ...original, stat: statMock };
      });
      const { registerFileSystemHandlers: registerHandlersWithPreciseStat } = await import('./fileSystem');
      const mgr = createRpcHandlerManager();
      registerHandlersWithPreciseStat(mgr as unknown as RpcHandlerManager, workspace);

      const statFile = mgr.handlers.get(RPC_METHODS.STAT_FILE);
      if (!statFile) throw new Error('expected statFile handler');

      await expect(statFile({ path: 'file.txt', includeContentHash: true })).resolves.toEqual({
        success: true,
        exists: true,
        kind: 'file',
        sizeBytes: 6,
        modifiedMs: 100.125,
        contentHash: expect.any(String),
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('statFile reports an exact content hash for an equal-size edit', async () => {
    // The exact failure a size+mtime revision cannot see: a rewrite that keeps
    // the length and puts the modification time back. The opt-in content hash
    // names those bytes; changedMs remains metadata for older consumers.
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-stat-'));
    try {
      const filePath = join(workspace, 'file.txt');
      // A modification time set from one Date on both writes, so the two stats
      // report it identically rather than merely closely.
      const pinnedModified = new Date(1_700_000_000_000);
      writeFileSync(filePath, 'hello', 'utf8');
      utimesSync(filePath, pinnedModified, pinnedModified);

      const mgr = createRpcHandlerManager();
      registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, workspace);
      const statFile = mgr.handlers.get(RPC_METHODS.STAT_FILE);
      if (!statFile) throw new Error('expected statFile handler');

      const before = await statFile({ path: 'file.txt', includeContentHash: true });

      writeFileSync(filePath, 'world', 'utf8');
      utimesSync(filePath, pinnedModified, pinnedModified);
      const after = await statFile({ path: 'file.txt', includeContentHash: true });

      expect(after.sizeBytes).toBe(before.sizeBytes);
      expect(after.modifiedMs).toBe(before.modifiedMs);
      expect(typeof before.changedMs).toBe('number');
      expect(after.changedMs).toBeGreaterThan(before.changedMs);
      expect(typeof before.contentHash).toBe('string');
      expect(typeof after.contentHash).toBe('string');
      expect(after.contentHash).not.toBe(before.contentHash);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('statFile hashes bytes when every timestamp collides', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-stat-'));
    try {
      const filePath = join(workspace, 'file.txt');
      const pinnedModified = new Date(1_700_000_000_000);
      writeFileSync(filePath, 'hello', 'utf8');
      utimesSync(filePath, pinnedModified, pinnedModified);

      const mgr = createRpcHandlerManager();
      registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, workspace);
      const statFile = mgr.handlers.get(RPC_METHODS.STAT_FILE);
      if (!statFile) throw new Error('expected statFile handler');
      const before = await statFile({ path: 'file.txt', includeContentHash: true });

      writeFileSync(filePath, 'world', 'utf8');
      utimesSync(filePath, pinnedModified, pinnedModified);
      const after = await statFile({ path: 'file.txt', includeContentHash: true });

      expect(after.sizeBytes).toBe(before.sizeBytes);
      expect(after.modifiedMs).toBe(before.modifiedMs);
      expect(after.contentHash).not.toBe(before.contentHash);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('does not hash a file that grows beyond the inline ceiling during the read', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-stat-'));
    try {
      writeFileSync(join(workspace, 'file.txt'), 'hello', 'utf8');
      const boundedRead = vi.fn(async (buffer: Buffer, offset: number, length: number) => {
        buffer.fill(0x61, offset, offset + length);
        return { bytesRead: length };
      });
      const openMock = vi.fn(async () => ({
        read: boundedRead,
        close: vi.fn(async () => undefined),
      }));
      vi.resetModules();
      vi.doMock('fs/promises', async (importOriginal) => {
        const original = await importOriginal<typeof import('fs/promises')>();
        return { ...original, open: openMock };
      });
      const { registerFileSystemHandlers: registerHandlersWithBoundedRead } = await import('./fileSystem');
      const mgr = createRpcHandlerManager();
      registerHandlersWithBoundedRead(mgr as unknown as RpcHandlerManager, workspace);

      const statFile = mgr.handlers.get(RPC_METHODS.STAT_FILE);
      if (!statFile) throw new Error('expected statFile handler');
      const result = await statFile({ path: 'file.txt', includeContentHash: true });

      // The mocked read fills the existing cap plus one byte, representing a
      // growth race. The response must omit a digest for that oversized buffer.
      expect(boundedRead).toHaveBeenCalledWith(expect.any(Buffer), 0, expect.any(Number), 0);
      expect(result).toMatchObject({ success: true, exists: true, kind: 'file', sizeBytes: 5 });
      expect(result.contentHash).toBeUndefined();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('renamePath creates parent dirs and supports overwriting', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-rename-'));
    try {
      writeFileSync(join(workspace, 'from.txt'), 'hello\n', 'utf8');
      writeFileSync(join(workspace, 'from2.txt'), 'hello2\n', 'utf8');
      writeFileSync(join(workspace, 'to.txt'), 'old\n', 'utf8');

      const mgr = createRpcHandlerManager();
      registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, workspace);

      const renamePath = mgr.handlers.get(RPC_METHODS.RENAME_PATH);
      if (!renamePath) throw new Error('expected renamePath handler');

      const noOverwrite = await renamePath({ from: 'from.txt', to: 'to.txt', overwrite: false });
      expect(noOverwrite).toMatchObject({ success: false });

      const overwrite = await renamePath({ from: 'from.txt', to: 'to.txt', overwrite: true });
      expect(overwrite).toMatchObject({ success: true });

      const nestedRename = await renamePath({ from: 'from2.txt', to: 'nested/to.txt', overwrite: false });
      expect(nestedRename).toMatchObject({ success: true });
      expect(statSync(join(workspace, 'nested', 'to.txt')).isFile()).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('deletePath refuses to delete directories without recursive=true', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-delete-'));
    try {
      mkdirSync(join(workspace, 'dir'), { recursive: true });
      writeFileSync(join(workspace, 'dir', 'file.txt'), 'hello\n', { encoding: 'utf8', flag: 'w' });

      const mgr = createRpcHandlerManager();
      registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, workspace);

      const deletePath = mgr.handlers.get(RPC_METHODS.DELETE_PATH);
      if (!deletePath) throw new Error('expected deletePath handler');

      const refused = await deletePath({ path: 'dir', recursive: false });
      expect(refused).toMatchObject({ success: false });

      const removed = await deletePath({ path: 'dir', recursive: true });
      expect(removed).toMatchObject({ success: true });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('deletePath refuses to delete the workspace root', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-files-delete-root-'));
    try {
      const mgr = createRpcHandlerManager();
      registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, workspace);

      const deletePath = mgr.handlers.get(RPC_METHODS.DELETE_PATH);
      if (!deletePath) throw new Error('expected deletePath handler');

      const result = await deletePath({ path: '.', recursive: true });
      expect(result).toMatchObject({ success: false });
      expect(String(result.error ?? '')).toContain('working directory root');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
