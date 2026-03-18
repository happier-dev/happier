import { describe, expect, it, vi } from 'vitest';

describe('executeSessionHandoffAction', () => {
  it('returns the handoff id when the action executor returns a successful handoff result', async () => {
    const { executeSessionHandoffAction } = await import('./executeSessionHandoffAction');

    const execute = vi.fn(async () => ({
      ok: true,
      result: {
        ok: true,
        handoffId: 'handoff_1',
        status: { handoffId: 'handoff_1', status: 'pending', phase: 'preparing', recoveryActions: [] },
        endpointCandidates: [],
      },
    }));

    const result = await executeSessionHandoffAction({
      execute: execute as any,
      sessionId: 'sess_1',
      targetMachineId: 'machine_target',
      context: { defaultSessionId: 'sess_1', surface: 'ui_button', placement: 'session_info' } as any,
    });

    expect(result).toEqual({ ok: true, handoffId: 'handoff_1' });
  });

  it('passes optional handoff options through to the action executor', async () => {
    const { executeSessionHandoffAction } = await import('./executeSessionHandoffAction');

    const execute = vi.fn(async () => ({
      ok: true,
      result: {
        ok: true,
        handoffId: 'handoff_1',
        status: { handoffId: 'handoff_1', status: 'pending', phase: 'preparing', recoveryActions: [] },
      },
    }));

    await executeSessionHandoffAction({
      execute: execute as any,
      sessionId: 'sess_1',
      targetMachineId: 'machine_target',
      targetSessionStorageMode: 'persisted',
      workspaceTransfer: {
        enabled: true,
        strategy: 'transfer_snapshot',
        conflictPolicy: 'replace_existing',
        includeIgnoredMode: 'include_selected',
        ignoredIncludeGlobs: ['dist/**'],
      },
      context: { defaultSessionId: 'sess_1', surface: 'ui_button', placement: 'session_info' } as any,
    });

    expect(execute).toHaveBeenCalledWith(
      'session.handoff',
      {
        sessionId: 'sess_1',
        targetMachineId: 'machine_target',
        targetSessionStorageMode: 'persisted',
        workspaceTransfer: {
          enabled: true,
          strategy: 'transfer_snapshot',
          conflictPolicy: 'replace_existing',
          includeIgnoredMode: 'include_selected',
          ignoredIncludeGlobs: ['dist/**'],
        },
      },
      expect.anything(),
    );
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
      context: { defaultSessionId: 'sess_1', surface: 'ui_button', placement: 'session_info' } as any,
    });

    expect(result).toEqual({ ok: false, error: 'unsupported_action:session.handoff' });
  });

  it('fails when the action result does not include a handoff id', async () => {
    const { executeSessionHandoffAction } = await import('./executeSessionHandoffAction');

    const execute = vi.fn(async () => ({
      ok: true,
      result: {
        ok: true,
        status: { handoffId: 'handoff_1', status: 'pending', phase: 'preparing', recoveryActions: [] },
        endpointCandidates: [],
      },
    }));

    const result = await executeSessionHandoffAction({
      execute: execute as any,
      sessionId: 'sess_1',
      targetMachineId: 'machine_target',
      context: { defaultSessionId: 'sess_1', surface: 'ui_button', placement: 'session_info' } as any,
    });

    expect(result).toEqual({ ok: false, error: 'failed_to_start_session_handoff' });
  });
});
