import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installSessionHandoffCommonModuleMocks } from '@/components/sessions/handoff/sessionHandoffTestHelpers';

const modalShowMock = vi.hoisted(() => vi.fn());
const modalHideMock = vi.hoisted(() => vi.fn());
const modalUpdateMock = vi.hoisted(() => vi.fn());
const modalConfirmMock = vi.hoisted(() => vi.fn());
const executeSessionHandoffActionMock = vi.hoisted(() => vi.fn());
const openSessionHandoffProgressModalMock = vi.hoisted(() => vi.fn());
const openSessionHandoffFailureRecoveryModalMock = vi.hoisted(() => vi.fn());
const performSessionHandoffRecoveryActionMock = vi.hoisted(() => vi.fn());
const randomUUIDMock = vi.hoisted(() => vi.fn(() => 'handoff-action-request-1'));

installSessionHandoffCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                show: (...args: unknown[]) => modalShowMock(...args),
                hide: (...args: unknown[]) => modalHideMock(...args),
                update: (...args: unknown[]) => modalUpdateMock(...args),
                confirm: (...args: unknown[]) => modalConfirmMock(...args),
            },
        }).module;
    },
});

vi.mock('./executeSessionHandoffAction', () => ({
  executeSessionHandoffAction: (...args: unknown[]) => executeSessionHandoffActionMock(...args),
}));

vi.mock('@/components/sessions/handoff/openSessionHandoffProgressModal', () => ({
  openSessionHandoffProgressModal: (...args: unknown[]) => openSessionHandoffProgressModalMock(...args),
}));

vi.mock('@/components/sessions/handoff/openSessionHandoffFailureRecoveryModal', () => ({
  openSessionHandoffFailureRecoveryModal: (...args: unknown[]) => openSessionHandoffFailureRecoveryModalMock(...args),
}));

vi.mock('../../ops/sessionHandoffs', () => ({
  performSessionHandoffRecoveryAction: (...args: unknown[]) => performSessionHandoffRecoveryActionMock(...args),
}));

vi.mock('@/sync/sync', () => ({ sync: { acquireUserRequestLease: () => () => {} } }));
vi.mock('@/platform/randomUUID', () => ({ randomUUID: () => randomUUIDMock() }));

describe('runSessionHandoffUiFlow', () => {
  beforeEach(() => {
    vi.resetModules();
    modalShowMock.mockReset();
    modalHideMock.mockReset();
    modalUpdateMock.mockReset();
    modalConfirmMock.mockReset();
    executeSessionHandoffActionMock.mockReset();
    openSessionHandoffProgressModalMock.mockReset();
    openSessionHandoffFailureRecoveryModalMock.mockReset();
    performSessionHandoffRecoveryActionMock.mockReset();
    openSessionHandoffProgressModalMock.mockReturnValue('modal_1');
  });

  it('shows a progress modal while the handoff runs and hides it after success', async () => {
    executeSessionHandoffActionMock.mockResolvedValueOnce({ ok: true, handoffId: 'handoff_1' });

    const { runSessionHandoffUiFlow } = await import('./runSessionHandoffUiFlow');
    const result = await runSessionHandoffUiFlow({
      execute: vi.fn() as any,
      sessionId: 'sess_1',
      targetMachineId: 'machine_target',
      context: { defaultSessionId: 'sess_1', surface: 'ui_button', placement: 'session_info' } as any,
    });

    expect(openSessionHandoffProgressModalMock).toHaveBeenCalledTimes(1);
    expect(modalHideMock).toHaveBeenCalledWith('modal_1');
    expect(modalConfirmMock).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, handoffId: 'handoff_1' });
  });

  it('updates the open progress modal from the canonical parent action operation while the flow is running', async () => {
    const actionResolution: {
      current: ((value: { ok: true; handoffId: string }) => void) | null;
    } = { current: null };
    executeSessionHandoffActionMock.mockImplementationOnce(
      () => new Promise((resolve) => {
        actionResolution.current = resolve as typeof actionResolution.current;
      }),
    );

    const { runSessionHandoffUiFlow } = await import('./runSessionHandoffUiFlow');
    const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');

    const flowPromise = runSessionHandoffUiFlow({
      execute: vi.fn() as any,
      sessionId: 'sess_1',
      targetMachineId: 'machine_target',
      context: { defaultSessionId: 'sess_1', surface: 'ui_button', placement: 'session_info' } as any,
    });

    await vi.waitFor(() => {
      expect(openSessionHandoffProgressModalMock).toHaveBeenCalledTimes(1);
    });

    actionOperationStore.merge({
      version: 1,
      operationId: 'handoff-operation-1',
      requestId: 'handoff-action-request-1',
      revision: 1,
      actionId: 'session.handoff',
      state: 'running',
      scope: { accountId: 'account-1', machineId: 'machine-source', sessionId: 'sess_1' },
      title: 'Hand off session',
      createdAt: 1,
      startedAt: 1,
      progress: { kind: 'determinate', current: 1024, total: 2048, label: 'Packaging session state' },
      cancellation: 'supported',
    });

    expect(modalUpdateMock).toHaveBeenCalledWith('modal_1', {
      operation: expect.objectContaining({
        requestId: 'handoff-action-request-1',
        progress: { kind: 'determinate', current: 1024, total: 2048, label: 'Packaging session state' },
      }),
    });

    actionResolution.current?.({ ok: true, handoffId: 'handoff_1' });
    await expect(flowPromise).resolves.toEqual({ ok: true, handoffId: 'handoff_1' });
  });

  it('offers retry when the handoff fails and reruns the handoff when confirmed', async () => {
    executeSessionHandoffActionMock
      .mockResolvedValueOnce({ ok: false, error: 'target_unreachable' })
      .mockResolvedValueOnce({ ok: true, handoffId: 'handoff_2' });
    openSessionHandoffProgressModalMock.mockReturnValueOnce('modal_1').mockReturnValueOnce('modal_2');
    modalConfirmMock.mockResolvedValueOnce(true);

    const { runSessionHandoffUiFlow } = await import('./runSessionHandoffUiFlow');
    const result = await runSessionHandoffUiFlow({
      execute: vi.fn() as any,
      sessionId: 'sess_1',
      targetMachineId: 'machine_target',
      context: { defaultSessionId: 'sess_1', surface: 'ui_button', placement: 'session_info' } as any,
    });

    expect(executeSessionHandoffActionMock).toHaveBeenCalledTimes(2);
    expect(modalHideMock).toHaveBeenNthCalledWith(1, 'modal_1');
    expect(modalHideMock).toHaveBeenNthCalledWith(2, 'modal_2');
    expect(modalConfirmMock).toHaveBeenCalledWith(
      'sessionHandoff.failure.title',
      'target_unreachable',
      {
        cancelText: 'common.cancel',
        confirmText: 'common.retry',
      },
    );
    expect(result).toEqual({ ok: true, handoffId: 'handoff_2' });
  });

  it('returns a handled cancellation result when the user declines retry', async () => {
    executeSessionHandoffActionMock.mockResolvedValueOnce({ ok: false, error: 'target_unreachable' });
    modalConfirmMock.mockResolvedValueOnce(false);

    const { runSessionHandoffUiFlow } = await import('./runSessionHandoffUiFlow');
    const result = await runSessionHandoffUiFlow({
      execute: vi.fn() as any,
      sessionId: 'sess_1',
      targetMachineId: 'machine_target',
      context: { defaultSessionId: 'sess_1', surface: 'ui_button', placement: 'session_info' } as any,
    });

    expect(result).toEqual({ ok: false, handled: true });
    expect(modalHideMock).toHaveBeenCalledWith('modal_1');
  });

  it('offers source recovery actions after a post-cutover failure and restarts on source when selected', async () => {
    executeSessionHandoffActionMock.mockResolvedValueOnce({
      ok: false,
      error: 'resume_failed',
      recovery: {
        handoffId: 'handoff_3',
        actions: ['restart_on_source', 'keep_stopped'],
        sourceResume: {
          sessionId: 'sess_3',
          machineId: 'machine_source',
          directory: '/repo',
          agent: 'claude',
          resume: 'claude_session_3',
          transcriptStorage: 'persisted',
          serverId: 'server_a',
        },
      },
    });
    openSessionHandoffFailureRecoveryModalMock.mockResolvedValueOnce('restart_on_source');
    performSessionHandoffRecoveryActionMock.mockResolvedValueOnce({ ok: true });

    const { runSessionHandoffUiFlow } = await import('./runSessionHandoffUiFlow');
    const result = await runSessionHandoffUiFlow({
      execute: vi.fn() as any,
      sessionId: 'sess_3',
      targetMachineId: 'machine_target',
      context: { defaultSessionId: 'sess_3', surface: 'ui_button', placement: 'session_info' } as any,
    });

    expect(openSessionHandoffFailureRecoveryModalMock).toHaveBeenCalledWith({
      title: 'sessionHandoff.recovery.title',
      message: 'sessionHandoff.recovery.messageAfterSourceStop',
      details: 'resume_failed',
      recovery: {
        handoffId: 'handoff_3',
        actions: ['restart_on_source', 'keep_stopped'],
        sourceResume: {
          sessionId: 'sess_3',
          machineId: 'machine_source',
          directory: '/repo',
          agent: 'claude',
          resume: 'claude_session_3',
          transcriptStorage: 'persisted',
          serverId: 'server_a',
        },
      },
    });
    expect(modalHideMock).toHaveBeenCalledWith('modal_1');
    expect(modalHideMock.mock.invocationCallOrder[0]).toBeLessThan(
      openSessionHandoffFailureRecoveryModalMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(performSessionHandoffRecoveryActionMock).toHaveBeenCalledWith({
      recovery: {
        handoffId: 'handoff_3',
        actions: ['restart_on_source', 'keep_stopped'],
        sourceResume: {
          sessionId: 'sess_3',
          machineId: 'machine_source',
          directory: '/repo',
          agent: 'claude',
          resume: 'claude_session_3',
          transcriptStorage: 'persisted',
          serverId: 'server_a',
        },
      },
      action: 'restart_on_source',
    });
    expect(result).toEqual({ ok: false, handled: true });
  });

  it('keeps a failed recovery in its recovery phase instead of rerunning the whole handoff', async () => {
    executeSessionHandoffActionMock.mockResolvedValueOnce({
      ok: false,
      error: 'resume_failed',
      recovery: {
        handoffId: 'handoff_4',
        actions: ['restart_on_source', 'keep_stopped'],
        sourceResume: {
          sessionId: 'sess_4',
          machineId: 'machine_source',
          directory: '/repo',
          agent: 'claude',
          resume: 'claude_session_4',
          transcriptStorage: 'persisted',
          serverId: 'server_a',
        },
      },
    });
    openSessionHandoffFailureRecoveryModalMock
      .mockResolvedValueOnce('restart_on_source')
      .mockResolvedValueOnce(null);
    performSessionHandoffRecoveryActionMock.mockResolvedValueOnce({ ok: false, error: 'source_resume_failed' });

    const { runSessionHandoffUiFlow } = await import('./runSessionHandoffUiFlow');
    const result = await runSessionHandoffUiFlow({
      execute: vi.fn() as any,
      sessionId: 'sess_4',
      targetMachineId: 'machine_target',
      context: { defaultSessionId: 'sess_4', surface: 'ui_button', placement: 'session_info' } as any,
    });

    expect(performSessionHandoffRecoveryActionMock).toHaveBeenCalledWith({
      recovery: {
        handoffId: 'handoff_4',
        actions: ['restart_on_source', 'keep_stopped'],
        sourceResume: {
          sessionId: 'sess_4',
          machineId: 'machine_source',
          directory: '/repo',
          agent: 'claude',
          resume: 'claude_session_4',
          transcriptStorage: 'persisted',
          serverId: 'server_a',
        },
      },
      action: 'restart_on_source',
    });
    expect(openSessionHandoffFailureRecoveryModalMock).toHaveBeenCalledTimes(2);
    expect(openSessionHandoffFailureRecoveryModalMock).toHaveBeenLastCalledWith(expect.objectContaining({
      details: 'source_resume_failed',
    }));
    expect(executeSessionHandoffActionMock).toHaveBeenCalledTimes(1);
    expect(modalConfirmMock).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, handled: true });
  });

  it('keeps post-commit source cleanup on its visible retry-only phase', async () => {
    const recovery = {
      handoffId: 'handoff_cleanup',
      actions: ['retry_source_cleanup'],
      sourceCleanup: {
        machineId: 'machine_source',
        serverId: 'server_a',
        workspaceReplicationReverseSourceRootPath: '/target/repo',
        workspaceReplicationReverseTargetRootPath: '/source/repo',
      },
    };
    executeSessionHandoffActionMock.mockResolvedValueOnce({
      ok: false,
      error: 'source_cleanup_failed',
      recovery,
    });
    openSessionHandoffFailureRecoveryModalMock
      .mockResolvedValueOnce('retry_source_cleanup')
      .mockResolvedValueOnce(null);
    performSessionHandoffRecoveryActionMock.mockResolvedValueOnce({
      ok: false,
      error: 'source_cleanup_still_failed',
    });

    const { runSessionHandoffUiFlow } = await import('./runSessionHandoffUiFlow');
    await expect(runSessionHandoffUiFlow({
      execute: vi.fn() as any,
      sessionId: 'sess_cleanup',
      targetMachineId: 'machine_target',
      context: { defaultSessionId: 'sess_cleanup', surface: 'ui_button', placement: 'session_info' } as any,
    })).resolves.toEqual({ ok: false, handled: true });

    expect(executeSessionHandoffActionMock).toHaveBeenCalledTimes(1);
    expect(performSessionHandoffRecoveryActionMock).toHaveBeenCalledTimes(1);
    expect(performSessionHandoffRecoveryActionMock).toHaveBeenCalledWith({
      recovery,
      action: 'retry_source_cleanup',
    });
    expect(openSessionHandoffFailureRecoveryModalMock).toHaveBeenLastCalledWith({
      title: 'sessionHandoff.failure.title',
      message: 'sessionHandoff.failure.message',
      details: 'source_cleanup_still_failed',
      recovery,
    });
    expect(modalConfirmMock).not.toHaveBeenCalled();
  });

  it('keeps a rejected post-commit recovery attempt inside the committed recovery phase', async () => {
    const recovery = {
      handoffId: 'handoff_cleanup_rejection',
      actions: ['retry_source_cleanup'],
      sourceCleanup: {
        machineId: 'machine_source',
        serverId: 'server_a',
        workspaceReplicationReverseSourceRootPath: '/target/repo',
        workspaceReplicationReverseTargetRootPath: '/source/repo',
      },
    };
    executeSessionHandoffActionMock.mockResolvedValueOnce({
      ok: false,
      error: 'source_cleanup_failed',
      recovery,
    });
    openSessionHandoffFailureRecoveryModalMock
      .mockResolvedValueOnce('retry_source_cleanup')
      .mockResolvedValueOnce(null);
    performSessionHandoffRecoveryActionMock.mockRejectedValueOnce(
      new Error('target finalization rejected'),
    );

    const { runSessionHandoffUiFlow } = await import('./runSessionHandoffUiFlow');
    await expect(runSessionHandoffUiFlow({
      execute: vi.fn() as any,
      sessionId: 'sess_cleanup_rejection',
      targetMachineId: 'machine_target',
      context: {
        defaultSessionId: 'sess_cleanup_rejection',
        surface: 'ui_button',
        placement: 'session_info',
      } as any,
    })).resolves.toEqual({ ok: false, handled: true });

    expect(executeSessionHandoffActionMock).toHaveBeenCalledTimes(1);
    expect(performSessionHandoffRecoveryActionMock).toHaveBeenCalledTimes(1);
    expect(openSessionHandoffFailureRecoveryModalMock).toHaveBeenCalledTimes(2);
    expect(openSessionHandoffFailureRecoveryModalMock).toHaveBeenLastCalledWith({
      title: 'sessionHandoff.failure.title',
      message: 'sessionHandoff.failure.message',
      details: 'target finalization rejected',
      recovery,
    });
    expect(modalConfirmMock).not.toHaveBeenCalled();
  });
});
