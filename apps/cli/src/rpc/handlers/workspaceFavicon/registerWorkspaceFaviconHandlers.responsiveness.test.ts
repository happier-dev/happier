import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';

const filesystemProbe = vi.hoisted(() => ({
  realpathSyncCalls: 0,
  realpathCallsByPath: new Map<string, number>(),
  readFileCallsByPath: new Map<string, number>(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    realpathSync: (...args: Parameters<typeof actual.realpathSync>) => {
      filesystemProbe.realpathSyncCalls += 1;
      return actual.realpathSync(...args);
    },
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const path = String(args[0]);
      filesystemProbe.readFileCallsByPath.set(path, (filesystemProbe.readFileCallsByPath.get(path) ?? 0) + 1);
      return actual.readFile(...args);
    },
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      const path = String(args[0]);
      filesystemProbe.realpathCallsByPath.set(path, (filesystemProbe.realpathCallsByPath.get(path) ?? 0) + 1);
      return actual.realpath(...args);
    },
  };
});

import { registerWorkspaceFaviconHandlers } from './registerWorkspaceFaviconHandlers';

type Handler = (payload: unknown) => unknown | Promise<unknown>;

function createRegistrar(): { handlers: Map<string, Handler>; registrar: RpcHandlerRegistrar } {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    registrar: {
      registerHandler: <TRequest, TResponse>(method: string, handler: (payload: TRequest) => TResponse | Promise<TResponse>) => {
        handlers.set(method, (payload: unknown) => handler(payload as TRequest));
      },
    },
  };
}

describe('workspace favicon event-loop responsiveness', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    filesystemProbe.realpathSyncCalls = 0;
    filesystemProbe.realpathCallsByPath.clear();
    filesystemProbe.readFileCallsByPath.clear();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('does not synchronously canonicalize every candidate against every restricted root', async () => {
    const container = mkdtempSync(join(tmpdir(), 'happier-workspace-favicon-responsive-'));
    tempDirs.push(container);
    const workspace = join(container, 'workspace');
    mkdirSync(workspace);
    const unrelatedRoots = Array.from({ length: 12 }, (_, index) => {
      const root = join(container, `unrelated-${index}`);
      mkdirSync(root);
      return root;
    });

    const { handlers, registrar } = createRegistrar();
    registerWorkspaceFaviconHandlers(registrar, {
      defaultDirectory: workspace,
      accessPolicy: { kind: 'restrictedRoots', roots: [...unrelatedRoots, workspace] },
    });

    const handler = handlers.get(RPC_METHODS.WORKSPACE_FAVICON_RESOLVE);
    if (!handler) throw new Error('expected workspace favicon handler');

    filesystemProbe.realpathSyncCalls = 0;
    await expect(handler({ workspacePath: workspace })).resolves.toEqual({ success: true, found: false });

    expect(filesystemProbe.realpathSyncCalls).toBe(0);
    for (const root of unrelatedRoots) {
      expect(filesystemProbe.realpathCallsByPath.get(root)).toBe(1);
    }
  });

  it('returns a direct favicon without reading lower-priority source files', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-workspace-favicon-direct-'));
    tempDirs.push(workspace);
    const sourcePath = join(workspace, 'index.html');
    writeFileSync(join(workspace, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(sourcePath, '<link rel="icon" href="/slower-favicon.png">');

    const { handlers, registrar } = createRegistrar();
    registerWorkspaceFaviconHandlers(registrar, {
      defaultDirectory: workspace,
      accessPolicy: { kind: 'restrictedRoots', roots: [workspace] },
    });

    const handler = handlers.get(RPC_METHODS.WORKSPACE_FAVICON_RESOLVE);
    if (!handler) throw new Error('expected workspace favicon handler');

    await expect(handler({ workspacePath: workspace })).resolves.toMatchObject({
      success: true,
      found: true,
      relativePath: 'favicon.svg',
    });
    expect(filesystemProbe.readFileCallsByPath.get(sourcePath) ?? 0).toBe(0);
  });

  it('keeps brace-sparse source parsing bounded', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-workspace-favicon-source-'));
    tempDirs.push(workspace);
    writeFileSync(join(workspace, 'index.html'), 'x'.repeat(20_000));

    const { handlers, registrar } = createRegistrar();
    registerWorkspaceFaviconHandlers(registrar, {
      defaultDirectory: workspace,
      accessPolicy: { kind: 'restrictedRoots', roots: [workspace] },
    });

    const handler = handlers.get(RPC_METHODS.WORKSPACE_FAVICON_RESOLVE);
    if (!handler) throw new Error('expected workspace favicon handler');

    const startedAt = performance.now();
    await expect(handler({ workspacePath: workspace })).resolves.toEqual({ success: true, found: false });
    expect(performance.now() - startedAt).toBeLessThan(500);
  });
});
