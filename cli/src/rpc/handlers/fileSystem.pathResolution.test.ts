import { describe, expect, it, vi } from 'vitest';

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

import { registerFileSystemHandlers } from './fileSystem';
import { RPC_METHODS } from '@happy/protocol/rpc';
import { resolve } from 'path';

function createRpcHandlerManager(): { handlers: Map<string, (data: any) => any>; registerHandler: (m: string, h: any) => void } {
  const handlers = new Map<string, (data: any) => any>();
  return {
    handlers,
    registerHandler(method, handler) {
      handlers.set(method, handler);
    },
  };
}

describe('registerFileSystemHandlers', () => {
  it('uses the validated resolved path for readFile/writeFile operations', async () => {
    const mgr = createRpcHandlerManager();
    registerFileSystemHandlers(mgr as any, '/work/dir');

    const read = mgr.handlers.get(RPC_METHODS.READ_FILE)!;
    await read({ path: 'notes.txt' });
    expect(readFile).toHaveBeenCalledWith(resolve('/work/dir', 'notes.txt'));

    const write = mgr.handlers.get(RPC_METHODS.WRITE_FILE)!;
    await write({ path: './sub/file.bin', content: Buffer.from('x').toString('base64'), expectedHash: null });
    expect(writeFile).toHaveBeenCalledWith(resolve('/work/dir', 'sub', 'file.bin'), expect.any(Buffer));
  });
});
