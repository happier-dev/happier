import { describe, expect, it, vi } from 'vitest';

describe('executeSessionHandoffAction', () => {
  it('preserves the explicit no-copy policy through Action admission and missing-state rejection', async () => {
    const { executeSessionHandoffAction } = await import('./executeSessionHandoffAction');
    const execute = vi.fn(async () => ({ ok: false as const, errorCode: 'existing_session_state_unavailable', error: 'Missing native history' }));
    await expect(executeSessionHandoffAction({ execute, sessionId: 'sess_1', targetMachineId: 'machine_target', stateTransfer: 'existing', workspaceAction: { kind: 'none' }, context: { surface: 'ui', placement: 'session_info' } })).resolves.toEqual({ ok: false, errorCode: 'existing_session_state_unavailable', error: 'Missing native history' });
    expect(execute).toHaveBeenCalledWith('session.handoff', expect.objectContaining({ stateTransfer: 'existing' }), expect.anything());
  });
  const status = { handoffId: 'handoff_1', status: 'completed' as const, phase: 'finalizing' as const, recoveryActions: [] };

  it('returns deferred approval as not admitted instead of an unsupported handoff failure', async () => {
    const { executeSessionHandoffAction } = await import('./executeSessionHandoffAction');
    const result = await executeSessionHandoffAction({
      execute: vi.fn(async () => ({ ok: true, result: { kind: 'approval_request_created', artifactId: 'approval-1', actionId: 'session.handoff' } })) as never,
      sessionId: 'sess_1',
      targetMachineId: 'machine_target',
      context: { defaultSessionId: 'sess_1', surface: 'ui', placement: 'session_info' },
    });
    expect(result).toEqual({ ok: true, kind: 'approval_required', artifactId: 'approval-1' });
  });

  it('returns the handoff id when the action executor returns a successful handoff result', async () => {
    const { executeSessionHandoffAction } = await import('./executeSessionHandoffAction');

    const execute = vi.fn(async () => ({
      ok: true,
      result: {
        handoffId: 'handoff_1',
        status,
        workspace: { kind: 'none' as const },
      },
    }));

    const result = await executeSessionHandoffAction({
      execute: execute as any,
      sessionId: 'sess_1',
      targetMachineId: 'machine_target',
      context: { defaultSessionId: 'sess_1', surface: 'ui', placement: 'session_info' } as any,
    });

    expect(result).toEqual({
      ok: true,
      result: { handoffId: 'handoff_1', status, workspace: { kind: 'none' } },
    });
  });

  it('passes optional handoff options through to the action executor', async () => {
    const { executeSessionHandoffAction } = await import('./executeSessionHandoffAction');

    const execute = vi.fn(async () => ({
      ok: true,
      result: {
        handoffId: 'handoff_1',
        status,
        workspace: { kind: 'none' as const },
      },
    }));

    await executeSessionHandoffAction({
      execute: execute as any,
      sessionId: 'sess_1',
      targetMachineId: 'machine_target',
      targetPath: '/home/guest/workspace',
      targetSessionStorageMode: 'persisted',
      workspaceAction: { kind: 'none' },
      context: { defaultSessionId: 'sess_1', surface: 'ui', placement: 'session_info' } as any,
    });

    expect(execute).toHaveBeenCalledWith(
      'session.handoff',
      {
        sessionId: 'sess_1',
        targetMachineId: 'machine_target',
        targetPath: '/home/guest/workspace',
        targetSessionStorageMode: 'persisted',
        workspaceAction: { kind: 'none' },
      },
      expect.anything(),
    );
  });

  it('returns the daemon-committed workspace outcome from the action result', async () => {
    const { executeSessionHandoffAction } = await import('./executeSessionHandoffAction');

    const execute = vi.fn(async () => ({
      ok: true,
      result: {
        handoffId: 'handoff_1',
        status,
        workspace: { kind: 'relationship', relationshipId: 'relationship-1', created: false },
      },
    }));

    await expect(executeSessionHandoffAction({
      execute: execute as any,
      sessionId: 'sess_1',
      targetMachineId: 'machine_target',
      workspaceAction: { kind: 'relationship', relationshipId: 'relationship-1', flushBeforeCommit: true },
      context: { defaultSessionId: 'sess_1', surface: 'ui', placement: 'session_info' } as any,
    })).resolves.toEqual({
      ok: true,
      result: {
        handoffId: 'handoff_1',
        status,
        workspace: { kind: 'relationship', relationshipId: 'relationship-1', created: false },
      },
    });
  });

  it('returns a normalized error when the action executor rejects the request', async () => {
    const { executeSessionHandoffAction } = await import('./executeSessionHandoffAction');

    const execute = vi.fn(async () => ({
      ok: false,
      errorCode: 'unsupported_action',
      error: 'unsupported_action:session.handoff',
    }));

    const result = await executeSessionHandoffAction({
      execute: execute as any,
      sessionId: 'sess_1',
      targetMachineId: 'machine_target',
      context: { defaultSessionId: 'sess_1', surface: 'ui', placement: 'session_info' } as any,
    });

    expect(result).toEqual({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:session.handoff' });
  });

  it('preserves only a validated immediate blocked-link result for the active picker request', async () => {
    const { executeSessionHandoffAction } = await import('./executeSessionHandoffAction');
    const details: { ok: boolean; errorCode: string; completed: unknown[]; blockedRelationshipId: string } = {
      ok: false, errorCode: 'relationship_conflicted', completed: [], blockedRelationshipId: 'hub-target',
    };
    const execute = vi.fn(async () => ({
      ok: false, errorCode: 'workspace_sync_partial_route_blocked', error: 'route blocked', details,
    }));
    await expect(executeSessionHandoffAction({
      execute: execute as never, sessionId: 'sess_1', targetMachineId: 'machine_target',
      workspaceAction: { kind: 'linked_workspace' },
      context: { defaultSessionId: 'sess_1', surface: 'ui', placement: 'session_info' },
    })).resolves.toEqual({
      ok: false, errorCode: 'workspace_sync_partial_route_blocked', error: 'route blocked', workspacePreparation: details,
    });

    execute.mockResolvedValueOnce({
      ok: false, errorCode: 'workspace_sync_partial_route_blocked', error: 'route blocked',
      details: { ...details, completed: [{ relationshipId: 'unverified' }] },
    });
    await expect(executeSessionHandoffAction({
      execute: execute as never, sessionId: 'sess_1', targetMachineId: 'machine_target',
      workspaceAction: { kind: 'linked_workspace' },
      context: { defaultSessionId: 'sess_1', surface: 'ui', placement: 'session_info' },
    })).resolves.toEqual({
      ok: false, errorCode: 'workspace_sync_partial_route_blocked', error: 'route blocked',
    });
  });

  it('fails when the action result does not include a handoff id', async () => {
    const { executeSessionHandoffAction } = await import('./executeSessionHandoffAction');

    const execute = vi.fn(async () => ({
      ok: true,
      result: {
        status,
        workspace: { kind: 'none' as const },
      },
    }));

    const result = await executeSessionHandoffAction({
      execute: execute as any,
      sessionId: 'sess_1',
      targetMachineId: 'machine_target',
      context: { defaultSessionId: 'sess_1', surface: 'ui', placement: 'session_info' } as any,
    });

    expect(result).toEqual({ ok: false, error: 'unsupported_session_handoff_result' });
  });
});
