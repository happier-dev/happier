import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor } from './actionExecutor.js';
import type { ActionExecutorDeps } from './executor/types.js';

const sessionSpawnInput = {
  creationKey: 'manual:stale-directory-proof-1',
  executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
  directory: '/workspace/project',
  organizationPlacement: { folderId: null, tagIds: [] },
  agentTarget: {
    kind: 'agent',
    identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
  },
} as const;

describe('session.spawn_new approval replay directory proof', () => {
  it('fails a stale approved proof at its original artifact without creating a nested approval or Session', async () => {
    const approvedProof = {
      v: 1 as const,
      executionTarget: sessionSpawnInput.executionTarget,
      directory: sessionSpawnInput.directory,
    };
    const changedProof = {
      v: 1 as const,
      executionTarget: sessionSpawnInput.executionTarget,
      directory: '/workspace/project-after-target-refresh',
    };
    const sessionSpawnNewDirectoryApprovalPreflight = vi.fn()
      .mockResolvedValueOnce({ type: 'approval_required' as const, approval: approvedProof })
      .mockResolvedValueOnce({ type: 'approval_required' as const, approval: changedProof });
    const sessionSpawnNew = vi.fn();
    const approvals = new Map<string, Record<string, unknown>>();
    let nextArtifact = 0;
    const approvalsCreate = vi.fn(async ({ request }: { request: Record<string, unknown> }) => {
      nextArtifact += 1;
      const artifactId = `approval-directory-${nextArtifact}`;
      approvals.set(artifactId, request);
      return { artifactId };
    });
    const approvalsGet = vi.fn(async ({ artifactId }: { artifactId: string }) => approvals.get(artifactId) ?? null);
    const approvalsUpdate = vi.fn(async ({ artifactId, request }: { artifactId: string; request: Record<string, unknown> }) => {
      approvals.set(artifactId, request);
      return { ok: true as const };
    });
    const executor = createActionExecutor({
      sessionSpawnNew,
      sessionSpawnNewDirectoryApprovalPreflight,
      approvalsCreate,
      approvalsGet,
      approvalsUpdate,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('session.spawn_new', sessionSpawnInput, {
      surface: 'cli',
    })).resolves.toEqual({
      ok: true,
      result: {
        kind: 'approval_request_created',
        artifactId: 'approval-directory-1',
        actionId: 'session.spawn_new',
      },
    });

    const replay = await executor.execute('approval.request.decide', {
      artifactId: 'approval-directory-1',
      decision: 'approve',
    }, { surface: 'cli' });

    expect.soft(replay).toMatchObject({
      ok: true,
      result: {
        ok: true,
        status: 'failed',
        execution: {
          ok: false,
          errorCode: 'approval_stale',
          error: 'approval_stale',
        },
      },
    });
    expect.soft(approvalsCreate).toHaveBeenCalledTimes(1);
    expect.soft(sessionSpawnNew).not.toHaveBeenCalled();
    expect.soft(approvals.get('approval-directory-1')).toMatchObject({
      status: 'failed',
      execution: { ok: false, errorCode: 'approval_stale' },
    });
  });
});
