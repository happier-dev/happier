import { describe, expect, it, vi } from 'vitest';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async () => Buffer.from('hello')),
  writeFile: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  stat: vi.fn(async () => {
    const err: NodeJS.ErrnoException = new Error('ENOENT');
    err.code = 'ENOENT';
    throw err;
  }),
}));

import { readFile, writeFile } from 'fs/promises';
import { stat } from 'fs/promises';

import { registerFileSystemHandlers } from './fileSystem';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { resolve } from 'path';

type Handler = (data: unknown) => Promise<unknown> | unknown;

function createRpcHandlerManager(): { handlers: Map<string, Handler>; registerHandler: (method: string, handler: Handler) => void } {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    registerHandler(method, handler) {
      handlers.set(method, handler);
    },
  };
}

describe('registerFileSystemHandlers', () => {
  it('rejects traversal-style paths for read and write', async () => {
    vi.clearAllMocks();
    const mgr = createRpcHandlerManager();
    registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, '/work/dir');

    const read = mgr.handlers.get(RPC_METHODS.READ_FILE);
    const write = mgr.handlers.get(RPC_METHODS.WRITE_FILE);
    if (!read || !write) throw new Error('expected file-system handlers to be registered');

    const readResult = await read({ path: '../outside.txt' });
    expect(readResult).toMatchObject({
      success: false,
    });
    expect(String((readResult as { error?: string }).error ?? '')).toContain('outside the allowed directories');

    const writeResult = await write({
      path: '../../outside.bin',
      content: Buffer.from('x').toString('base64'),
      expectedHash: null,
    });
    expect(writeResult).toMatchObject({
      success: false,
    });
    expect(String((writeResult as { error?: string }).error ?? '')).toContain('outside the allowed directories');
    expect(readFile).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('does not allow writing outside working directory even when additional read roots are configured', async () => {
    vi.clearAllMocks();
    const mgr = createRpcHandlerManager();
    registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, '/work/dir', {
      getAdditionalAllowedReadDirs: () => ['/tmp/allowed'],
    });

    const write = mgr.handlers.get(RPC_METHODS.WRITE_FILE);
    if (!write) throw new Error('expected write handler');

    const writeResult = await write({
      path: '/tmp/allowed/file.bin',
      content: Buffer.from('x').toString('base64'),
      expectedHash: null,
    });
    expect(writeResult).toMatchObject({ success: false });
    expect(String((writeResult as { error?: string }).error ?? '')).toContain('outside the allowed directories');
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('uses the validated resolved path for readFile/writeFile operations', async () => {
    vi.clearAllMocks();
    const mgr = createRpcHandlerManager();
    registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, '/work/dir');

    const read = mgr.handlers.get(RPC_METHODS.READ_FILE);
    if (!read) throw new Error('expected read handler');
    await read({ path: 'notes.txt' });
    expect(readFile).toHaveBeenCalledWith(resolve('/work/dir', 'notes.txt'));

    const write = mgr.handlers.get(RPC_METHODS.WRITE_FILE);
    if (!write) throw new Error('expected write handler');
    await write({ path: './sub/file.bin', content: Buffer.from('x').toString('base64'), expectedHash: null });
    expect(writeFile).toHaveBeenCalledWith(resolve('/work/dir', 'sub', 'file.bin'), expect.any(Buffer));
  });

  it('allows overwriting an existing file when expectedHash is undefined', async () => {
    vi.clearAllMocks();
    const mgr = createRpcHandlerManager();
    registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, '/work/dir');

    const write = mgr.handlers.get(RPC_METHODS.WRITE_FILE);
    if (!write) throw new Error('expected write handler');

    // Simulate an existing file.
    vi.mocked(stat).mockResolvedValueOnce({} as any);

    const writeResult = await write({
      path: 'exists.txt',
      content: Buffer.from('updated').toString('base64'),
      // expectedHash intentionally omitted / undefined: should be treated as "no expectation".
      expectedHash: undefined,
    });

    expect(writeResult).toMatchObject({ success: true });
    expect(writeFile).toHaveBeenCalledWith(resolve('/work/dir', 'exists.txt'), expect.any(Buffer));
  });

  it('rejects overwriting an existing file when expectedHash is null (new file expected)', async () => {
    vi.clearAllMocks();
    const mgr = createRpcHandlerManager();
    registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, '/work/dir');

    const write = mgr.handlers.get(RPC_METHODS.WRITE_FILE);
    if (!write) throw new Error('expected write handler');

    // Simulate an existing file.
    vi.mocked(stat).mockResolvedValueOnce({} as any);

    const writeResult = await write({
      path: 'exists.txt',
      content: Buffer.from('updated').toString('base64'),
      expectedHash: null,
    });

    expect(writeResult).toMatchObject({ success: false });
    expect(String((writeResult as any).error ?? '')).toContain('expected to be new');
    expect(writeFile).not.toHaveBeenCalled();
  });
});
