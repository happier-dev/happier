import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor } from './actionExecutor.js';
import { getActionSpec, PublicActionIdSchema } from './actionSpecs.js';
import type { ActionExecutorDeps } from './executor/types.js';

const relationshipsResult = {
  controllerMachineId: 'machine-a',
  sets: [],
  relationships: [],
  remoteRelationships: [],
  membership: { workspaceRefId: 'workspace-a', found: false },
  discoveryAvailable: true,
};

const conflictPage = {
  status: 'page' as const,
  relationshipId: 'rel-ab',
  totalCount: 0,
  nextCursor: null,
  conflicts: [],
};

const inspectResult = {
  controllerMachineId: 'machine-a',
  hubWorkspaceRefId: 'workspace-a',
  path: 'src/index.ts',
  endpoints: [
    {
      workspaceRefId: 'workspace-a',
      outcome: 'observed' as const,
      observation: { kind: 'missing' as const },
      selections: [],
    },
  ],
  versions: [{ endpointWorkspaceRefIds: ['workspace-a'], entry: { kind: 'missing' as const } }],
  coverage: { complete: true },
};

function createExecutor(deps: Partial<ActionExecutorDeps>) {
  return createActionExecutor({
    isApprovalExecutionOriginCurrent: async () => true,
    ...deps,
  } as unknown as ActionExecutorDeps);
}

describe('workspace sync read Actions', () => {
  it('exposes relationships.list, conflicts.list and conflict.inspect as safe agent/MCP/CLI reads', () => {
    for (
      const [id, mcpToolName] of [
        ['workspace.sync.relationships.list', 'workspace_sync_relationships_list'],
        ['workspace.sync.conflicts.list', 'workspace_sync_conflicts_list'],
        ['workspace.sync.conflict.inspect', 'workspace_sync_conflict_inspect'],
      ] as const
    ) {
      const spec = getActionSpec(id);
      expect(spec.safety).toBe('safe');
      expect(spec.surfaces).toMatchObject({ agent: true, mcp: true, cli: true, rpc: false });
      expect(spec.bindings?.mcpToolName).toBe(mcpToolName);
      // Same public-API footing as the other safe account_automation reads
      // such as session.status.get: API-token callers stay narrowed to the
      // public schema and gain no Team access from MCP exposure.
      expect(PublicActionIdSchema.safeParse(id).success).toBe(true);
    }
  });

  it('executes relationships.list through its exact-controller dependency without approval', async () => {
    const workspaceSyncRelationshipsList = vi.fn(async () => relationshipsResult);
    const executor = createExecutor({ workspaceSyncRelationshipsList });
    const result = await executor.execute(
      'workspace.sync.relationships.list',
      { controllerMachineId: 'machine-a' },
      { surface: 'agent', authority: 'account_automation', serverId: 'server-1' },
    );
    expect(result).toEqual({ ok: true, result: relationshipsResult });
    expect(workspaceSyncRelationshipsList).toHaveBeenCalledWith({
      context: expect.objectContaining({ surface: 'agent', authority: 'account_automation', serverId: 'server-1' }),
      input: { controllerMachineId: 'machine-a' },
    });
  });

  it('executes conflicts.list for one relationship page without approval', async () => {
    const workspaceSyncConflictsList = vi.fn(async () => conflictPage);
    const executor = createExecutor({ workspaceSyncConflictsList });
    const result = await executor.execute(
      'workspace.sync.conflicts.list',
      { controllerMachineId: 'machine-a', relationshipId: 'rel-ab', limit: 50 },
      { surface: 'agent', authority: 'account_automation', serverId: 'server-1' },
    );
    expect(result).toEqual({ ok: true, result: conflictPage });
    expect(workspaceSyncConflictsList).toHaveBeenCalledWith({
      context: expect.objectContaining({ surface: 'agent', authority: 'account_automation', serverId: 'server-1' }),
      input: { controllerMachineId: 'machine-a', relationshipId: 'rel-ab', limit: 50 },
    });
  });

  it('rejects a relationships inventory outside the canonical closed output contract', async () => {
    const executor = createExecutor({
      workspaceSyncRelationshipsList: async () => ({ ...relationshipsResult, unexpected: true }),
    });
    await expect(executor.execute(
      'workspace.sync.relationships.list',
      { controllerMachineId: 'machine-a' },
      { surface: 'agent', authority: 'account_automation', serverId: 'server-1' },
    )).resolves.toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
  });

  it('executes conflict.inspect for a set-member path without approval', async () => {
    const workspaceSyncConflictInspect = vi.fn(async () => inspectResult);
    const executor = createExecutor({ workspaceSyncConflictInspect });
    const result = await executor.execute(
      'workspace.sync.conflict.inspect',
      { controllerMachineId: 'machine-a', workspaceRefId: 'workspace-c', path: 'src/index.ts' },
      { surface: 'agent', authority: 'account_automation', serverId: 'server-1' },
    );
    expect(result).toEqual({ ok: true, result: inspectResult });
    expect(workspaceSyncConflictInspect).toHaveBeenCalledWith({
      context: expect.objectContaining({ surface: 'agent', authority: 'account_automation', serverId: 'server-1' }),
      input: { controllerMachineId: 'machine-a', workspaceRefId: 'workspace-c', path: 'src/index.ts' },
    });
  });

  it('reports unsupported_action when a read dependency is not wired', async () => {
    const executor = createExecutor({});
    await expect(executor.execute(
      'workspace.sync.relationships.list',
      { controllerMachineId: 'machine-a' },
      { surface: 'agent', authority: 'account_automation', serverId: 'server-1' },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'unsupported_action',
      error: 'unsupported_action:workspace.sync.relationships.list',
    });
    await expect(executor.execute(
      'workspace.sync.conflict.inspect',
      { controllerMachineId: 'machine-a', workspaceRefId: 'workspace-c', path: 'src/index.ts' },
      { surface: 'agent', authority: 'account_automation', serverId: 'server-1' },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'unsupported_action',
      error: 'unsupported_action:workspace.sync.conflict.inspect',
    });
  });
});
