import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RPC_METHODS, type WorkspaceFaviconResolveResponseV1 } from '@happier-dev/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
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

describe('registerWorkspaceFaviconHandlers', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('resolves the first supported favicon candidate inside the workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-workspace-favicon-'));
    tempDirs.push(root);
    mkdirSync(join(root, 'public'), { recursive: true });
    writeFileSync(join(root, 'public', 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" />');

    const { handlers, registrar } = createRegistrar();
    registerWorkspaceFaviconHandlers(registrar, {
      defaultDirectory: root,
      accessPolicy: { kind: 'restrictedRoots', roots: [root] },
    });

    const handler = handlers.get(RPC_METHODS.WORKSPACE_FAVICON_RESOLVE);
    if (!handler) throw new Error('expected workspace favicon handler');

    const response = await handler({ workspacePath: root }) as WorkspaceFaviconResolveResponseV1;

    expect(response).toMatchObject({
      success: true,
      found: true,
      relativePath: 'public/favicon.svg',
      mimeType: 'image/svg+xml',
    });
    if (response.success && response.found) {
      expect(Buffer.from(response.contentBase64, 'base64').toString('utf8')).toContain('<svg');
    }
  });

  it('uses relative icon links discovered in an index file without escaping the workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-workspace-favicon-'));
    tempDirs.push(root);
    mkdirSync(join(root, 'assets'), { recursive: true });
    writeFileSync(join(root, 'index.html'), '<link rel="icon" href="/assets/app-icon.png">');
    writeFileSync(join(root, 'assets', 'app-icon.png'), 'png');

    const { handlers, registrar } = createRegistrar();
    registerWorkspaceFaviconHandlers(registrar, {
      defaultDirectory: root,
      accessPolicy: { kind: 'restrictedRoots', roots: [root] },
    });

    const response = await handlers.get(RPC_METHODS.WORKSPACE_FAVICON_RESOLVE)?.({ workspacePath: root }) as WorkspaceFaviconResolveResponseV1;

    expect(response).toMatchObject({
      success: true,
      found: true,
      relativePath: 'assets/app-icon.png',
      mimeType: 'image/png',
    });
  });

  it('finds icons declared by nested package roots in monorepo workspaces', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-workspace-favicon-'));
    tempDirs.push(root);
    mkdirSync(join(root, 'apps', 'ui', 'src'), { recursive: true });
    mkdirSync(join(root, 'apps', 'ui', 'public'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['apps/*'] }));
    writeFileSync(join(root, 'apps', 'ui', 'package.json'), JSON.stringify({ name: 'ui' }));
    writeFileSync(join(root, 'apps', 'ui', 'src', 'root.tsx'), "export const links = () => [{ rel: 'icon', href: '/logo.png' }];");
    writeFileSync(join(root, 'apps', 'ui', 'public', 'logo.png'), 'png');

    const { handlers, registrar } = createRegistrar();
    registerWorkspaceFaviconHandlers(registrar, {
      defaultDirectory: root,
      accessPolicy: { kind: 'restrictedRoots', roots: [root] },
    });

    const response = await handlers.get(RPC_METHODS.WORKSPACE_FAVICON_RESOLVE)?.({ workspacePath: root }) as WorkspaceFaviconResolveResponseV1;

    expect(response).toMatchObject({
      success: true,
      found: true,
      relativePath: 'apps/ui/public/logo.png',
      mimeType: 'image/png',
    });
  });

  it('returns missing for workspaces without a supported icon and fails closed for disallowed roots', async () => {
    const allowedRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-favicon-'));
    const outsideRoot = mkdtempSync(join(tmpdir(), 'happier-workspace-favicon-outside-'));
    tempDirs.push(allowedRoot, outsideRoot);

    const { handlers, registrar } = createRegistrar();
    registerWorkspaceFaviconHandlers(registrar, {
      defaultDirectory: allowedRoot,
      accessPolicy: { kind: 'restrictedRoots', roots: [allowedRoot] },
    });

    expect(await handlers.get(RPC_METHODS.WORKSPACE_FAVICON_RESOLVE)?.({ workspacePath: allowedRoot })).toEqual({
      success: true,
      found: false,
    });

    expect(await handlers.get(RPC_METHODS.WORKSPACE_FAVICON_RESOLVE)?.({ workspacePath: outsideRoot })).toMatchObject({
      success: false,
      errorCode: 'INVALID_WORKSPACE_PATH',
    });
  });
});
