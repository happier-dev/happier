import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonFilesystemListDirectoryResponseSchema, DaemonFilesystemListRootsResponseSchema } from '@happier-dev/protocol/machines/fileBrowser';
import { createFilesystemEffectAdmission } from '../fileSystem/accessPolicy/filesystemEffectAdmission';

import { registerMachineFileBrowserHandlers } from './registerMachineFileBrowserHandlers';

type Handler = (data: unknown) => Promise<unknown> | unknown;

const tempDirectories: string[] = [];

function createTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'happier-machine-browser-'));
  tempDirectories.push(directory);
  return directory;
}

function createRegistrar(): { handlers: Map<string, Handler>; registrar: RpcHandlerRegistrar } {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    registrar: {
      registerHandler(method, handler) {
        handlers.set(method, handler as Handler);
      },
    },
  };
}

afterEach(() => {
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop();
    if (!directory) continue;
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('registerMachineFileBrowserHandlers', () => {
  it('preserves filesystem admission cause in both file browser result readers', async () => {
    const { handlers, registrar } = createRegistrar();
    registerMachineFileBrowserHandlers({ rpcHandlerManager: registrar, workingDirectory: '/workspace',
      effectAdmission: createFilesystemEffectAdmission() });
    for (const [method, schema] of [
      [RPC_METHODS.DAEMON_FILESYSTEM_LIST_ROOTS, DaemonFilesystemListRootsResponseSchema],
      [RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY, DaemonFilesystemListDirectoryResponseSchema],
    ] as const) {
      expect(schema.parse(await handlers.get(method)!({ path: '/workspace' }))).toMatchObject({
        ok: false, errorCode: 'filesystem_identity_custody_unavailable', details: { reason: 'requester_identity_unavailable' },
      });
    }
  });
  it('carries the OS reason code when a browsed directory no longer exists', async () => {
    const root = createTempDirectory();
    const { handlers, registrar } = createRegistrar();
    registerMachineFileBrowserHandlers({
      rpcHandlerManager: registrar,
      workingDirectory: root,
      deps: { resolveRoots: async () => [{ id: root, label: root, path: root }] },
    });
    const listDirectory = handlers.get(RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY);
    if (!listDirectory) throw new Error('expected machine file browser directory handler');
    await expect(listDirectory({ path: join(root, 'missing') })).resolves.toMatchObject({
      ok: false,
      errorCode: 'ENOENT',
    });
  });

  it('dispatches machine file-browser RPCs through ActionSpec when an executor is provided', async () => {
    const execute = vi.fn(async () => ({
      ok: true,
      result: { ok: true, roots: [] },
    }));
    const { handlers, registrar } = createRegistrar();

    registerMachineFileBrowserHandlers({
      rpcHandlerManager: registrar,
      workingDirectory: '/tmp',
      actionExecutor: { execute },
    } as any);

    const listRoots = handlers.get(RPC_METHODS.DAEMON_FILESYSTEM_LIST_ROOTS);
    if (!listRoots) {
      throw new Error('expected machine file-browser root handler');
    }

    await expect(listRoots({})).resolves.toEqual({ ok: true, roots: [] });

    expect(execute).toHaveBeenCalledWith(
      'daemon.filesystem.listRoots',
      {},
      expect.objectContaining({ surface: 'rpc' }),
    );
  });

  it('registers machine-root browse handlers and lists directories lazily', async () => {
    const root = createTempDirectory();
    mkdirSync(join(root, 'folder'));
    writeFileSync(join(root, 'notes.txt'), 'hello');
    const resolvedRoot = realpathSync(root);
    const { handlers, registrar } = createRegistrar();

    registerMachineFileBrowserHandlers({
      rpcHandlerManager: registrar,
      workingDirectory: root,
      deps: {
        resolveRoots: async () => [{ id: root, label: root, path: root }],
        maxEntries: 200,
        statConcurrency: 4,
        platform: 'darwin',
      },
    });

    expect(handlers.has(RPC_METHODS.DAEMON_FILESYSTEM_LIST_ROOTS)).toBe(true);
    expect(handlers.has(RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY)).toBe(true);

    const listRoots = handlers.get(RPC_METHODS.DAEMON_FILESYSTEM_LIST_ROOTS);
    const listDirectory = handlers.get(RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY);
    if (!listRoots || !listDirectory) {
      throw new Error('expected machine file browser handlers to be registered');
    }

    await expect(listRoots({})).resolves.toEqual({
      ok: true,
      roots: [{ id: root, label: root, path: root }],
    });

    await expect(listDirectory({ path: root, includeFiles: false })).resolves.toEqual({
      ok: true,
      path: resolvedRoot,
      entries: [
        {
          name: 'folder',
          path: join(resolvedRoot, 'folder'),
          type: 'directory',
          size: expect.any(Number),
          modified: expect.any(Number),
        },
      ],
      truncated: false,
    });
  });

  it('uses the injected platform consistently for both roots and directory browsing', async () => {
    const { handlers, registrar } = createRegistrar();
    const seenPlatforms: Array<NodeJS.Platform | undefined> = [];
    const seenWorkingDirectories: Array<string | undefined> = [];

    registerMachineFileBrowserHandlers({
      rpcHandlerManager: registrar,
      workingDirectory: '/tmp',
      deps: {
        resolveRoots: async (input) => {
          seenPlatforms.push(input?.platform);
          seenWorkingDirectories.push(input?.workingDirectory);
          return [{ id: '/', label: '/', path: '/' }];
        },
        maxEntries: 200,
        statConcurrency: 4,
        platform: 'win32',
      },
    });

    const listRoots = handlers.get(RPC_METHODS.DAEMON_FILESYSTEM_LIST_ROOTS);
    const listDirectory = handlers.get(RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY);
    if (!listRoots || !listDirectory) {
      throw new Error('expected machine file browser handlers to be registered');
    }

    await listRoots({});
    await listDirectory({ path: '/', includeFiles: false });

    expect(seenPlatforms).toEqual(['win32', 'win32']);
    expect(seenWorkingDirectories).toEqual(['/tmp', '/tmp']);
  });
});
