import { describe, expect, it } from 'vitest';

import { WorkspaceContentPolicyV1Schema } from '../sessions/control/handoff/workspaceSyncSchemas.js';
import { createActionExecutor } from './actionExecutor.js';
import { getActionSpec } from './actionSpecs.js';
import type { ActionExecutorDeps } from './executor/types.js';

describe('workspace sync relationship policy discovery', () => {
  it('publishes the relationship creation MCP binding alongside its RPC binding', () => {
    expect(getActionSpec('workspace.sync.relationship.create').bindings).toMatchObject({
      mcpToolName: 'workspace_sync_relationship_create',
    });
  });
  it('gives Agent and UI callers complete digest-bearing policy choices', async () => {
    const field = getActionSpec('workspace.sync.relationship.create').inputHints?.fields
      .find((candidate) => candidate.path === 'contentPolicy');
    expect(field).toMatchObject({ widget: 'select', required: true });
    expect(field?.options).toHaveLength(2);
    for (const option of field?.options ?? []) {
      expect(WorkspaceContentPolicyV1Schema.safeParse(option.value).success).toBe(true);
    }

    const executor = createActionExecutor({} as ActionExecutorDeps);
    const resolved = await executor.execute('action.options.resolve', {
      actionId: 'workspace.sync.relationship.create', fieldPath: 'contentPolicy',
    }, { surface: 'agent', authority: 'account_automation' });
    expect(resolved).toMatchObject({
      ok: true,
      result: {
        actionId: 'workspace.sync.relationship.create',
        fieldPath: 'contentPolicy',
        options: expect.arrayContaining([
          expect.objectContaining({ value: expect.objectContaining({ selection: 'git_worktree', policyDigest: expect.any(String) }) }),
          expect.objectContaining({ value: expect.objectContaining({ selection: 'all_files', policyDigest: expect.any(String) }) }),
        ]),
      },
    });
    if (!resolved.ok) throw new Error(resolved.error);
    const options = getActionSpec('action.options.resolve').outputSchema!.parse(resolved.result).options;
    for (const option of options) {
      expect(getActionSpec('workspace.sync.relationship.create').inputSchema.safeParse({
        v: 1,
        sourceWorkspaceRefId: '46bcce80-a314-400a-98eb-656df965e06e',
        targetMachineId: '58f6e63a-cd69-4302-83f1-325d10da7ec3',
        targetPath: '/home/happier/mqa2-c23-sync-target',
        mode: 'keep_both_in_sync',
        contentPolicy: option.value,
        destinationIntent: 'materialize_from_source_workspace',
      }).success).toBe(true);
    }
  });
});
