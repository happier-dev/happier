import { describe, expect, it, vi } from 'vitest';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';

vi.mock('fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('fs/promises')>(),
  readFile: vi.fn(async () => Buffer.from('hello')),
  writeFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  stat: vi.fn(async () => {
    const err: NodeJS.ErrnoException = new Error('ENOENT');
    err.code = 'ENOENT';
    throw err;
  }),
}));

import { readFile, readdir, writeFile } from 'fs/promises';
import { mkdir } from 'fs/promises';
import { stat } from 'fs/promises';

import { registerFileSystemHandlers } from './fileSystem';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { resolve } from 'path';

const restrictedWorkDirPolicy = { kind: 'restrictedRoots', roots: ['/work/dir'] } as const;

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
  it('dispatches filesystem read RPCs through ActionSpec when an executor is provided', async () => {
    const execute = vi.fn(async () => ({
      ok: true as const,
      result: { success: true, content: Buffer.from('hello', 'utf8').toString('base64') },
    }));
    const mgr = createRpcHandlerManager();

    registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, '/work/dir', {
      actionExecutor: { execute },
    });

    const read = mgr.handlers.get(RPC_METHODS.READ_FILE);
    if (!read) {
      throw new Error('expected readFile handler');
    }

    await expect(read({ path: '/work/dir/README.md' })).resolves.toEqual({
      success: true,
      content: Buffer.from('hello', 'utf8').toString('base64'),
    });

    expect(execute).toHaveBeenCalledWith(
      'daemon.filesystem.readFile',
      { path: '/work/dir/README.md' },
      expect.objectContaining({ surface: 'rpc' }),
    );
  });

    it('dispatches filesystem mutation and directory RPCs through ActionSpec when an executor is provided', async () => {
    const execute = vi.fn(async (actionId: string) => ({
      ok: true as const,
      result: { success: true, actionId },
    }));
    const mgr = createRpcHandlerManager();

    registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, '/work/dir', {
      actionExecutor: { execute },
    });

    const write = mgr.handlers.get(RPC_METHODS.WRITE_FILE);
    const listDirectory = mgr.handlers.get(RPC_METHODS.LIST_DIRECTORY);
    const getDirectoryTree = mgr.handlers.get(RPC_METHODS.GET_DIRECTORY_TREE);
    if (!write || !listDirectory || !getDirectoryTree) {
      throw new Error('expected file-system ActionSpec handlers');
    }

    await expect(write({ path: '/work/dir/out.txt', content: 'eA==' })).resolves.toEqual({
      success: true,
      actionId: 'daemon.filesystem.writeFile',
    });
    await expect(listDirectory({ path: '/work/dir' })).resolves.toEqual({
      success: true,
      actionId: 'daemon.filesystem.listDirectory',
    });
    await expect(getDirectoryTree({ path: '/work/dir', maxDepth: 1 })).resolves.toEqual({
      success: true,
      actionId: 'daemon.filesystem.getDirectoryTree',
    });

    expect(execute).toHaveBeenCalledWith(
      'daemon.filesystem.writeFile',
      { path: '/work/dir/out.txt', content: 'eA==' },
      expect.objectContaining({ surface: 'rpc' }),
    );
    expect(execute).toHaveBeenCalledWith(
      'daemon.filesystem.listDirectory',
      { path: '/work/dir' },
      expect.objectContaining({ surface: 'rpc' }),
    );
    expect(execute).toHaveBeenCalledWith(
      'daemon.filesystem.getDirectoryTree',
      { path: '/work/dir', maxDepth: 1 },
      expect.objectContaining({ surface: 'rpc' }),
    );
  });

  it('allows absolute writes outside the default directory by default', async () => {
    vi.clearAllMocks();
    const mgr = createRpcHandlerManager();
    registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, '/work/dir');

    const write = mgr.handlers.get(RPC_METHODS.WRITE_FILE);
    if (!write) throw new Error('expected write handler');

    const writeResult = await write({
      path: '/tmp/happier-outside-root/file.bin',
      content: Buffer.from('x').toString('base64'),
      expectedHash: null,
    });

    expect(writeResult).toMatchObject({ success: true });
    expect(writeFile).toHaveBeenCalledWith(resolve('/tmp/happier-outside-root/file.bin'), expect.any(Buffer));
  });

  it('rejects traversal-style paths for read and write', async () => {
    vi.clearAllMocks();
    const mgr = createRpcHandlerManager();
    registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, '/work/dir', {
      accessPolicy: restrictedWorkDirPolicy,
    });

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

  it('allows only an exact transient file grant for restricted reads', async () => {
    vi.clearAllMocks();
    const mgr = createRpcHandlerManager();
    const grantedPath = '/tmp/transient-media/granted.png';
    registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, '/work/dir', {
      accessPolicy: restrictedWorkDirPolicy,
      getAdditionalAllowedReadFiles: () => [{ path: grantedPath, realPath: grantedPath }],
    });

    const read = mgr.handlers.get(RPC_METHODS.READ_FILE);
    if (!read) throw new Error('expected read handler');

    vi.mocked(stat).mockResolvedValueOnce({
      size: 5,
      mtime: new Date(),
      isDirectory: () => false,
    } as any);
    await expect(read({ path: grantedPath })).resolves.toMatchObject({ success: true });
    await expect(read({ path: '/tmp/transient-media/sibling-secret.png' })).resolves.toMatchObject({
      success: false,
    });
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('does not allow writing outside working directory even when additional read roots are configured', async () => {
    vi.clearAllMocks();
    const mgr = createRpcHandlerManager();
    registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, '/work/dir', {
      accessPolicy: restrictedWorkDirPolicy,
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
    vi.mocked(stat).mockResolvedValueOnce({ size: 1, mtime: new Date(), isDirectory: () => false } as any);
    await read({ path: 'notes.txt' });
    expect(readFile).toHaveBeenCalledWith(resolve('/work/dir', 'notes.txt'));

    const write = mgr.handlers.get(RPC_METHODS.WRITE_FILE);
    if (!write) throw new Error('expected write handler');
    await write({ path: './sub/file.bin', content: Buffer.from('x').toString('base64'), expectedHash: null });
    expect(mkdir).toHaveBeenCalledWith(resolve('/work/dir', 'sub'), { recursive: true });
    expect(writeFile).toHaveBeenCalledWith(resolve('/work/dir', 'sub', 'file.bin'), expect.any(Buffer));
  });

  it('allows directory tree reads from configured additional read roots', async () => {
    vi.clearAllMocks();
    const mgr = createRpcHandlerManager();
    registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, '/work/dir', {
      getAdditionalAllowedReadDirs: () => ['/tmp/allowed'],
    });

    const getDirectoryTree = mgr.handlers.get(RPC_METHODS.GET_DIRECTORY_TREE);
    if (!getDirectoryTree) throw new Error('expected getDirectoryTree handler');

    vi.mocked(stat).mockResolvedValueOnce({
      size: 1,
      mtime: new Date(),
      isDirectory: () => true,
    } as any);

    const result = await getDirectoryTree({ path: '/tmp/allowed', maxDepth: 0 });
    expect(result).toMatchObject({
      success: true,
      tree: {
        path: resolve('/tmp/allowed'),
        type: 'directory',
      },
    });
  });

  it('bounds directory listing and tree traversal RPC responses', async () => {
    vi.clearAllMocks();
    const mgr = createRpcHandlerManager();
    registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, '/work/dir', {
      directoryLimits: {
        listMaxEntries: 2,
        treeMaxDepth: 1,
        treeMaxNodes: 3,
      },
    });

    const listDirectory = mgr.handlers.get(RPC_METHODS.LIST_DIRECTORY);
    const getDirectoryTree = mgr.handlers.get(RPC_METHODS.GET_DIRECTORY_TREE);
    if (!listDirectory || !getDirectoryTree) throw new Error('expected directory handlers');

    vi.mocked(readdir).mockResolvedValueOnce([
      { name: 'a.txt', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
      { name: 'b.txt', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
      { name: 'c.txt', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
    ] as any);
    vi.mocked(stat).mockResolvedValue({ size: 1, mtime: new Date(), isDirectory: () => false } as any);

    await expect(listDirectory({ path: '/work/dir' })).resolves.toMatchObject({
      success: true,
      entries: [
        expect.objectContaining({ name: 'a.txt' }),
        expect.objectContaining({ name: 'b.txt' }),
      ],
      truncated: true,
    });

    vi.clearAllMocks();
    vi.mocked(stat)
      .mockResolvedValueOnce({ size: 1, mtime: new Date(), isDirectory: () => true } as any)
      .mockResolvedValue({ size: 1, mtime: new Date(), isDirectory: () => false } as any);
    vi.mocked(readdir).mockResolvedValueOnce([
      { name: 'a.txt', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
      { name: 'b.txt', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
      { name: 'c.txt', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
    ] as any);

    await expect(getDirectoryTree({ path: '/work/dir', maxDepth: 99 })).resolves.toMatchObject({
      success: true,
      truncated: true,
      tree: {
        type: 'directory',
        children: [
          expect.objectContaining({ name: 'a.txt' }),
          expect.objectContaining({ name: 'b.txt' }),
        ],
      },
    });
  });

  it('rejects reading files larger than the configured read limit', async () => {
    vi.clearAllMocks();
    const mgr = createRpcHandlerManager();
    registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, '/work/dir');

    const read = mgr.handlers.get(RPC_METHODS.READ_FILE);
    if (!read) throw new Error('expected read handler');

    vi.mocked(stat).mockResolvedValueOnce({ size: 3_000_000, mtime: new Date() } as any);
    const result = await read({ path: 'big.bin' });

    expect(result).toMatchObject({ success: false });
    expect(readFile).not.toHaveBeenCalled();
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

  it('registers a createDirectory handler that uses the validated resolved path', async () => {
    vi.clearAllMocks();
    const mgr = createRpcHandlerManager();
    registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, '/work/dir');

    const createDirectory = mgr.handlers.get('createDirectory');
    if (!createDirectory) throw new Error('expected createDirectory handler');

    const result = await createDirectory({ path: 'tmp/new-folder' });
    expect(result).toMatchObject({ success: true });
    expect(mkdir).toHaveBeenCalledWith(resolve('/work/dir', 'tmp', 'new-folder'), { recursive: true });
  });
});
