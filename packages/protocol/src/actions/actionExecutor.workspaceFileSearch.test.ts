import { describe, expect, it } from 'vitest';

import { ActionIdSchema } from './actionIds.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';
import { listActionSpecsForCatalogSurface } from './actionCatalog.js';

describe('workspace file content search Action', () => {
  it('exposes the machine read and preserves partial coverage through the public executor', async () => {
    expect(ActionIdSchema.safeParse('workspace.files.search').success).toBe(true);
    const id = ActionIdSchema.parse('workspace.files.search');
    const spec = getActionSpec(id);
    for (const surface of ['ui', 'cli', 'mcp', 'agent'] as const) {
      expect(listActionSpecsForCatalogSurface({ surface }).map((item) => item.id)).toContain(id);
    }
    expect(spec).toMatchObject({ safety: 'safe', sideEffectClass: 'read', executionPlacement: 'machine' });
    expect(spec.inputSchema.safeParse({ machineId: 'machine', rootPath: '/repo', query: 'needle', serverId: 'other' }).success).toBe(false);
    const input = { machineId: 'machine', rootPath: '/repo', query: 'needle', regex: false };
    const page = { ok: true as const, files: [{ path: 'a.ts', matches: [{ line: 3, column16: 2, length16: 6, text: '  needle', before: [], after: [] }] }], hasMore: true, coverage: 'partial' as const };
    const seen: unknown[] = [];
    // This adapter is the remote daemon/filesystem boundary; admission and result parsing stay real.
    const executor = createActionExecutor({
      workspaceFilesSearch: async (request: unknown, context: unknown) => { seen.push({ request, context }); return page; },
    } as unknown as ActionExecutorDeps);
    const signal = new AbortController().signal;
    await expect(executor.execute(id, input, { surface: 'agent', serverId: 'home', signal })).resolves.toEqual({ ok: true, result: page });
    expect(seen).toMatchObject([{ request: input, context: { serverId: 'home', signal } }]);
  });

  it('preserves invalid regex as a typed daemon outcome rather than an empty page', async () => {
    expect(ActionIdSchema.safeParse('workspace.files.search').success).toBe(true);
    const id = ActionIdSchema.parse('workspace.files.search');
    const executor = createActionExecutor({
      workspaceFilesSearch: async () => ({ ok: false, code: 'invalid_pattern' }),
    } as unknown as ActionExecutorDeps);
    await expect(executor.execute(id, { machineId: 'machine', rootPath: '/repo', query: '[', regex: true }, { surface: 'mcp' }))
      .resolves.toEqual({ ok: true, result: { ok: false, code: 'invalid_pattern' } });
  });
});
