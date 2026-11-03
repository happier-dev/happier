import { describe, expect, it, vi } from 'vitest';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { RpcHandler } from '@/api/rpc/types';

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
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFilesystemOwnerRpcContext, registerOwnerFilesystemRpcHandlers as registerFileSystemHandlers } from './fileSystem.testkit';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { resolve } from 'path';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { accountSettingsParse } from '@happier-dev/protocol';

const realFs = await vi.importActual<typeof import('fs/promises')>('fs/promises');

/**
 * Guarded writes stage a temporary file beside the destination and rename it, so their
 * contract is observed on the real filesystem: the module-wide mocks above are lifted for
 * the duration of one write scenario and a real temporary working directory is used.
 */
async function withRealWriteFilesystem(run: (roots: Readonly<{ work: string; outside: string }>) => Promise<void>) {
  const work = await realFs.mkdtemp(join(tmpdir(), 'happier-fs-work-'));
  const outside = await realFs.mkdtemp(join(tmpdir(), 'happier-fs-outside-'));
  const mocked = [[writeFile, realFs.writeFile], [mkdir, realFs.mkdir], [stat, realFs.stat]] as const;
  const previous = mocked.map(([mock]) => vi.mocked(mock).getMockImplementation());
  mocked.forEach(([mock, real]) => vi.mocked(mock as (...args: never[]) => unknown).mockImplementation(real as never));
  try {
    await run({ work, outside });
  } finally {
    mocked.forEach(([mock], index) => vi.mocked(mock as (...args: never[]) => unknown).mockImplementation(previous[index] as never));
    await Promise.all([work, outside].map(root => realFs.rm(root, { recursive: true, force: true })));
  }
}

const restrictedWorkDirPolicy = { kind: 'restrictedRoots', roots: ['/work/dir'] } as const;

// This transport-boundary registry stores handlers with their request type erased.
type Handler = RpcHandler;

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
  it('keeps admitted owner reads useful while refusing a member without native custody', async () => {
    const work = await realFs.mkdtemp(join(tmpdir(), 'happier-fs-owner-custody-'));
    const path = join(work, 'private-fixture');
    vi.mocked(readFile).mockImplementation(realFs.readFile);
    vi.mocked(stat).mockImplementation(realFs.stat);
    const mgr = createRpcHandlerManager();
    const registration = registerFileSystemHandlers(mgr, work);
    try {
      await realFs.writeFile(path, 'synthetic-owner-only-bytes', { mode: 0o600 });
      const read = mgr.handlers.get(RPC_METHODS.READ_FILE);
      if (!read) throw new Error('expected read handler');
      const owner = createFilesystemOwnerRpcContext();
      if (!owner.machineAdmission) throw new Error('expected owner Machine receipt');
      const positive = await read({ path });
      expect(positive.success === true && positive.content === Buffer.from('synthetic-owner-only-bytes').toString('base64')).toBe(true);
      const refused = await read({ path }, { ...owner, machineAdmission: {
        ...owner.machineAdmission, actorAccountId: 'member', role: 'use' as const,
      } });
      expect({ success: refused.success, errorCode: refused.errorCode }).toEqual({
        success: false, errorCode: 'filesystem_identity_custody_unavailable',
      });
      expect(refused).not.toHaveProperty('content');
      const admitted = await read({ path }, { ...owner, verifyMachineAdmissionCurrent: async () => false });
      expect(admitted).toMatchObject({ success: true, content: Buffer.from('synthetic-owner-only-bytes').toString('base64') });
      expect(await realFs.readFile(path, 'utf8') === 'synthetic-owner-only-bytes').toBe(true);
    } finally {
      vi.mocked(readFile).mockReset();
      vi.mocked(stat).mockReset();
      await registration.dispose();
      await realFs.rm(work, { recursive: true, force: true });
    }
  });

  it('admits predecessor rootless filesystem requests through the real canonical Action parser', async () => {
    const mgr = createRpcHandlerManager();
    // No filesystem effect is mounted: reaching its typed unsupported result proves
    // that real Action admission accepted the legacy carrier without mocking parsing.
    const { executor } = createCliActionExecutorHarness({
      token: 'admitted-daemon', sessionId: '', mode: 'plain', ctx: null,
      machineActionDirectTargetTransport: { machineId: 'machine', invoke: async () => {
        throw new Error('Local filesystem admission must not invoke Machine RPC');
      } },
      actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({
        actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'daemon.filesystem.writeFile': ['rpc'] } },
      }) }),
    }, { filesystemActionExecute: undefined });
    const registration = registerFileSystemHandlers(mgr, '/work/dir', {
      actionExecutor: { execute: (actionId, input, context) => executor.execute(actionId, input, {
        ...context, serverId: 'home', runtimeAccountId: 'account',
        externalActionTarget: { kind: 'machine', machineId: 'machine' },
      }) },
    });
    try {
      for (const [method, input] of [
        [RPC_METHODS.LIST_DIRECTORY, { path: '/work/dir', includeGitIgnore: true }],
        [RPC_METHODS.GET_DIRECTORY_TREE, { path: '/work/dir', maxDepth: 1 }],
        [RPC_METHODS.READ_FILE, { path: '/work/dir/README' }],
        [RPC_METHODS.WRITE_FILE, { path: '/work/dir/notes', content: 'eA==' }],
      ] as const) {
        const handler = mgr.handlers.get(method);
        if (!handler) throw new Error(`expected filesystem handler: ${method}`);
        await expect(handler(input)).resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
      }
      const listDirectory = mgr.handlers.get(RPC_METHODS.LIST_DIRECTORY);
      if (!listDirectory) throw new Error('expected directory handler');
      await expect(listDirectory({ rootPath: 42, path: '/work/dir' }))
        .resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    } finally { await registration.dispose(); }
  });

  it('allows absolute writes outside the default directory by default', async () => {
    await withRealWriteFilesystem(async ({ work, outside }) => {
      const mgr = createRpcHandlerManager();
      registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, work);

      const write = mgr.handlers.get(RPC_METHODS.WRITE_FILE);
      if (!write) throw new Error('expected write handler');

      const writeResult = await write({
        path: join(outside, 'file.bin'),
        content: Buffer.from('x').toString('base64'),
        expectedHash: null,
      });

      expect(writeResult).toMatchObject({ success: true });
      expect(await realFs.readFile(join(outside, 'file.bin'), 'utf8')).toBe('x');
    });
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
      errorCode: 'access_denied',
    });
    expect(String((readResult as { error?: string }).error ?? '')).toContain('outside the allowed directories');

    const writeResult = await write({
      path: '../../outside.bin',
      content: Buffer.from('x').toString('base64'),
      expectedHash: null,
    });
    expect(writeResult).toMatchObject({
      success: false,
      errorCode: 'access_denied',
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
    await expect(read({ rootPath: '/work/dir', path: grantedPath })).resolves.toMatchObject({ success: false });
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
    await withRealWriteFilesystem(async ({ work }) => {
      const mgr = createRpcHandlerManager();
      registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, work);

      const read = mgr.handlers.get(RPC_METHODS.READ_FILE);
      if (!read) throw new Error('expected read handler');
      vi.mocked(stat).mockResolvedValueOnce({ size: 1, mtime: new Date(), isDirectory: () => false } as any);
      await read({ path: 'notes.txt' });
      expect(readFile).toHaveBeenCalledWith(resolve(work, 'notes.txt'));

      const write = mgr.handlers.get(RPC_METHODS.WRITE_FILE);
      if (!write) throw new Error('expected write handler');
      await expect(write({ path: './sub/file.bin', content: Buffer.from('x').toString('base64'), expectedHash: null }))
        .resolves.toMatchObject({ success: true });
      expect(await realFs.readFile(join(work, 'sub', 'file.bin'), 'utf8')).toBe('x');
    });
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
    await withRealWriteFilesystem(async ({ work }) => {
      await realFs.writeFile(join(work, 'exists.txt'), 'old');
      const mgr = createRpcHandlerManager();
      registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, work);

      const write = mgr.handlers.get(RPC_METHODS.WRITE_FILE);
      if (!write) throw new Error('expected write handler');

      const writeResult = await write({
        path: 'exists.txt',
        content: Buffer.from('updated').toString('base64'),
        // expectedHash intentionally omitted / undefined: should be treated as "no expectation".
        expectedHash: undefined,
      });

      expect(writeResult).toMatchObject({ success: true });
      expect(await realFs.readFile(join(work, 'exists.txt'), 'utf8')).toBe('updated');
    });
  });

  it('rejects overwriting an existing file when expectedHash is null (new file expected)', async () => {
    await withRealWriteFilesystem(async ({ work }) => {
      await realFs.writeFile(join(work, 'exists.txt'), 'old');
      const mgr = createRpcHandlerManager();
      registerFileSystemHandlers(mgr as unknown as RpcHandlerManager, work);

      const write = mgr.handlers.get(RPC_METHODS.WRITE_FILE);
      if (!write) throw new Error('expected write handler');

      const writeResult = await write({
        path: 'exists.txt',
        content: Buffer.from('updated').toString('base64'),
        expectedHash: null,
      });

      expect(writeResult).toMatchObject({ success: false });
      expect(String((writeResult as any).error ?? '')).toContain('expected to be new');
      expect(await realFs.readFile(join(work, 'exists.txt'), 'utf8')).toBe('old');
    });
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
