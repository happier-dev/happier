import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

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
  it('registers machine-root browse handlers and lists directories lazily', async () => {
    const root = createTempDirectory();
    mkdirSync(join(root, 'folder'));
    writeFileSync(join(root, 'notes.txt'), 'hello');
    const { handlers, registrar } = createRegistrar();

    registerMachineFileBrowserHandlers({
      rpcHandlerManager: registrar,
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
      path: root,
      entries: [
        {
          name: 'folder',
          path: join(root, 'folder'),
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

    registerMachineFileBrowserHandlers({
      rpcHandlerManager: registrar,
      deps: {
        resolveRoots: async (input) => {
          seenPlatforms.push(input?.platform);
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
  });
});
