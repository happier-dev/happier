import { describe, expect, it } from 'vitest';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { statSync } from 'node:fs';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerFileSystemHandlers } from './fileSystem';

type Handler = (data: any) => Promise<any>;

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
