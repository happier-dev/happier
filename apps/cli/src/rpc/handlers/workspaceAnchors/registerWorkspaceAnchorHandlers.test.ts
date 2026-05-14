import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RPC_METHODS, computeLineContentHashV1, type WorkspaceAnchorsResolveResponseV1 } from '@happier-dev/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { registerWorkspaceAnchorHandlers } from './registerWorkspaceAnchorHandlers';

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

describe('registerWorkspaceAnchorHandlers', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('resolves exact and moved line anchors in one batched request', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-workspace-anchors-'));
    tempDirs.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'index.ts'), [
      'const first = 1;',
      'const moved = 2;',
      'const third = 3;',
    ].join('\n'));

    const { handlers, registrar } = createRegistrar();
    registerWorkspaceAnchorHandlers(registrar, {
      defaultDirectory: root,
      accessPolicy: { kind: 'restrictedRoots', roots: [root] },
    });

    const handler = handlers.get(RPC_METHODS.WORKSPACE_ANCHORS_RESOLVE);
    if (!handler) throw new Error('expected workspace anchor handler');

    const response = await handler({
      workspacePath: root,
      comments: [
        {
          id: 'exact',
          filePath: 'src/index.ts',
          source: 'file',
          anchor: {
            kind: 'line',
            filePath: 'src/index.ts',
            line: 1,
            lineHash: computeLineContentHashV1('const first = 1;'),
          },
        },
        {
          id: 'moved',
          filePath: 'src/index.ts',
          source: 'file',
          anchor: {
            kind: 'line',
            filePath: 'src/index.ts',
            line: 99,
            lineHash: computeLineContentHashV1('const moved = 2;'),
          },
        },
      ],
    }) as WorkspaceAnchorsResolveResponseV1;

    expect(response.success).toBe(true);
    if (!response.success) return;
    expect(response.resolutions).toMatchObject([
      { id: 'exact', status: 'exact', confidence: 1, resolvedAnchor: { kind: 'line', line: 1 } },
      { id: 'moved', status: 'hash', confidence: 0.85, resolvedAnchor: { kind: 'line', line: 2 } },
    ]);
  });

  it('reports ambiguous hash matches instead of guessing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-workspace-anchors-'));
    tempDirs.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'index.ts'), ['same();', 'same();'].join('\n'));

    const { handlers, registrar } = createRegistrar();
    registerWorkspaceAnchorHandlers(registrar, {
      defaultDirectory: root,
      accessPolicy: { kind: 'restrictedRoots', roots: [root] },
    });

    const response = await handlers.get(RPC_METHODS.WORKSPACE_ANCHORS_RESOLVE)?.({
      workspacePath: root,
      comments: [{
        id: 'ambiguous',
        filePath: 'src/index.ts',
        source: 'file',
        anchor: {
          kind: 'line',
          filePath: 'src/index.ts',
          line: 20,
          lineHash: computeLineContentHashV1('same();'),
        },
      }],
    }) as WorkspaceAnchorsResolveResponseV1;

    expect(response.success).toBe(true);
    if (!response.success) return;
    expect(response.resolutions[0]).toMatchObject({
      id: 'ambiguous',
      status: 'ambiguous',
      confidence: 0.2,
    });
  });
});
