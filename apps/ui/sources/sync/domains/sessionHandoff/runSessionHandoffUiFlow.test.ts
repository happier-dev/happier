import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installSessionHandoffCommonModuleMocks } from '@/components/sessions/handoff/sessionHandoffTestHelpers';

const modalShowMock = vi.hoisted(() => vi.fn());
const modalHideMock = vi.hoisted(() => vi.fn());
const modalUpdateMock = vi.hoisted(() => vi.fn());
const modalConfirmMock = vi.hoisted(() => vi.fn());
const modalAlertMock = vi.hoisted(() => vi.fn());
const executeSessionHandoffActionMock = vi.hoisted(() => vi.fn());
const openSessionHandoffProgressModalMock = vi.hoisted(() => vi.fn());
const openSessionHandoffFailureRecoveryModalMock = vi.hoisted(() => vi.fn());
const performSessionHandoffRecoveryActionMock = vi.hoisted(() => vi.fn());
const randomUUIDMock = vi.hoisted(() => vi.fn());

installSessionHandoffCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                show: (...args: unknown[]) => modalShowMock(...args),
                hide: (...args: unknown[]) => modalHideMock(...args),
                update: (...args: unknown[]) => modalUpdateMock(...args),
                confirm: (...args: unknown[]) => modalConfirmMock(...args),
                alert: (...args: unknown[]) => modalAlertMock(...args),
            },
        }).module;
    },
});

vi.mock('@/platform/randomUUID', () => ({
  randomUUID: () => randomUUIDMock(),
}));

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

describe('runSessionHandoffUiFlow', () => {
  beforeEach(() => {
    vi.resetModules();
    modalShowMock.mockReset();
    modalHideMock.mockReset();
    modalUpdateMock.mockReset();
    modalConfirmMock.mockReset();
    modalAlertMock.mockReset();
    executeSessionHandoffActionMock.mockReset();
    openSessionHandoffProgressModalMock.mockReset();
    openSessionHandoffFailureRecoveryModalMock.mockReset();
    performSessionHandoffRecoveryActionMock.mockReset();
    randomUUIDMock.mockReset();
    randomUUIDMock.mockReturnValue('resume_attempt_1');
    openSessionHandoffProgressModalMock.mockReturnValue('modal_1');
  });

  it('shows a progress modal while the handoff runs and hides it after success', async () => {
    executeSessionHandoffActionMock.mockResolvedValueOnce({ ok: true, handoffId: 'handoff_1' });

    const { runSessionHandoffUiFlow } = await import('./runSessionHandoffUiFlow');
    const result = await runSessionHandoffUiFlow({
      execute: vi.fn() as any,
      sessionId: 'sess_1',
      targetMachineId: 'machine_target',
      context: { defaultSessionId: 'sess_1', surface: 'ui', placement: 'session_info' } as any,
    });

    expect(openSessionHandoffProgressModalMock).toHaveBeenCalledTimes(1);
    expect(modalHideMock).toHaveBeenCalledWith('modal_1');
    expect(modalConfirmMock).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, handoffId: 'handoff_1' });
  });

  it('updates the open progress modal when matching handoff status events are published while the flow is running', async () => {
    const actionResolution: {
      current: ((value: { ok: true; handoffId: string }) => void) | null;
    } = { current: null };
    executeSessionHandoffActionMock.mockImplementationOnce(
      () => new Promise((resolve) => {
        actionResolution.current = resolve as typeof actionResolution.current;
      }),
    );

    const { runSessionHandoffUiFlow } = await import('./runSessionHandoffUiFlow');
    const { publishSessionHandoffProgress } = await import('./sessionHandoffProgressEvents');

    const flowPromise = runSessionHandoffUiFlow({
      execute: vi.fn() as any,
      sessionId: 'sess_1',
      targetMachineId: 'machine_target',
      context: { defaultSessionId: 'sess_1', surface: 'ui', placement: 'session_info' } as any,
    });

    await vi.waitFor(() => {
      expect(openSessionHandoffProgressModalMock).toHaveBeenCalledTimes(1);
    });

    publishSessionHandoffProgress({
      sessionId: 'sess_1',
      targetMachineId: 'machine_target',
      status: {
        handoffId: 'handoff_1',
        status: 'pending',
        phase: 'staging_target',
        workspacePreflightSummary: {
          addedPathsCount: 3,
          changedPathsCount: 2,
          removedPathsCount: 1,
          totalBytes: 2048,
        },
        progress: {
          updatedAtMs: 123,
          checkpoint: 'transfer_blobs',
          planned: {
            totalFiles: 6,
            totalBytes: 2048,
          },
          transferred: {
            files: 3,
            bytes: 1024,
            blobs: 2,
          },
          current: {
            relativePath: 'README.md',
          },
          resumable: true,
        },
        recoveryActions: [],
      },
    });

    expect(modalUpdateMock).toHaveBeenCalledWith('modal_1', {
      status: expect.objectContaining({
        handoffId: 'handoff_1',
        phase: 'staging_target',
        workspacePreflightSummary: expect.objectContaining({
          addedPathsCount: 3,
          changedPathsCount: 2,
          removedPathsCount: 1,
        }),
        progress: expect.objectContaining({
          checkpoint: 'transfer_blobs',
        }),
      }),
    });

    actionResolution.current?.({ ok: true, handoffId: 'handoff_1' });
    await expect(flowPromise).resolves.toEqual({ ok: true, handoffId: 'handoff_1' });
  });

  it('updates the modal from the canonical parent action operation during source packaging', async () => {
    const actionResolution: { current: ((value: { ok: true; handoffId: string }) => void) | null } = { current: null };
    executeSessionHandoffActionMock.mockImplementationOnce(() => new Promise((resolve) => {
      actionResolution.current = resolve as typeof actionResolution.current;
    }));
    const { runSessionHandoffUiFlow } = await import('./runSessionHandoffUiFlow');
    const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
    const flowPromise = runSessionHandoffUiFlow({
      execute: vi.fn() as any,
      sessionId: 'sess_1',
      targetMachineId: 'machine_target',
      context: {
        defaultSessionId: 'sess_1',
        surface: 'ui',
        placement: 'session_info',
        actionRequestId: 'handoff-action-request-1',
      } as any,
    });

    await vi.waitFor(() => expect(openSessionHandoffProgressModalMock).toHaveBeenCalledTimes(1));
    actionOperationStore.mergeSnapshots([{
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
    }]);

    expect(modalUpdateMock).toHaveBeenCalledWith('modal_1', {
      operation: expect.objectContaining({ requestId: 'handoff-action-request-1' }),
    });
    actionResolution.current?.({ ok: true, handoffId: 'handoff_1' });
    await flowPromise;
  });

  it('keeps hydrated interrupted handoff status passive and sends one exact revision-bound Resume only after the user presses it', async () => {
    const actionResolution: {
      current: ((value: { ok: true; handoffId: string }) => void) | null;
    } = { current: null };
    executeSessionHandoffActionMock.mockImplementationOnce(
      () => new Promise((resolve) => {
        actionResolution.current = resolve as typeof actionResolution.current;
      }),
    );
    const execute = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        ok: true,
        handoffId: 'handoff_interrupted_1',
        jobId: 'prepare_job_1',
        transitionRevision: 8,
        status: {
          handoffId: 'handoff_interrupted_1',
          jobId: 'prepare_job_1',
          status: 'in_progress',
          phase: 'staging_target',
          recoveryActions: [],
        },
      },
    });

    const { runSessionHandoffUiFlow } = await import('./runSessionHandoffUiFlow');
    const { publishSessionHandoffProgress } = await import('./sessionHandoffProgressEvents');
    const flowPromise = runSessionHandoffUiFlow({
      execute: execute as any,
      sessionId: 'sess_1',
      targetMachineId: 'machine_target',
      context: { defaultSessionId: 'sess_1', surface: 'ui', placement: 'session_info' } as any,
    });

    publishSessionHandoffProgress({
      sessionId: 'sess_1',
      targetMachineId: 'machine_target',
      transitionRevision: 7,
      status: {
        handoffId: 'handoff_interrupted_1',
        jobId: 'prepare_job_1',
        status: 'awaiting_user_resume',
        phase: 'staging_target',
        recoveryActions: [],
      },
    });

    expect(execute).not.toHaveBeenCalled();
    expect(randomUUIDMock).not.toHaveBeenCalled();
    const interruptedUpdate = modalUpdateMock.mock.calls.at(-1)?.[1] as {
      onResume?: () => Promise<void>;
    };
    expect(interruptedUpdate.onResume).toEqual(expect.any(Function));

    await Promise.all([
      interruptedUpdate.onResume?.(),
      interruptedUpdate.onResume?.(),
    ]);

    expect(randomUUIDMock).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      'session.handoff.prepare_target.resume',
      {
        handoffId: 'handoff_interrupted_1',
        jobId: 'prepare_job_1',
        expectedRevision: 7,
        attemptId: 'resume_attempt_1',
      },
      { defaultSessionId: 'sess_1', surface: 'ui', placement: 'session_info' },
    );
    expect(modalUpdateMock).toHaveBeenLastCalledWith('modal_1', {
      status: expect.objectContaining({
        handoffId: 'handoff_interrupted_1',
        status: 'in_progress',
      }),
      onResume: undefined,
    });
    expect(modalAlertMock).not.toHaveBeenCalled();

    actionResolution.current?.({ ok: true, handoffId: 'handoff_interrupted_1' });
    await flowPromise;
  });

  it('surfaces a typed stale Resume rejection and does not report progress', async () => {
    const actionResolution: {
      current: ((value: { ok: true; handoffId: string }) => void) | null;
    } = { current: null };
    executeSessionHandoffActionMock.mockImplementationOnce(
      () => new Promise((resolve) => {
        actionResolution.current = resolve as typeof actionResolution.current;
      }),
    );
    const execute = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        ok: false,
        error: {
          code: 'stale_revision',
          message: 'The interrupted handoff changed before Resume was accepted.',
        },
      },
    });

    const { runSessionHandoffUiFlow } = await import('./runSessionHandoffUiFlow');
    const { publishSessionHandoffProgress } = await import('./sessionHandoffProgressEvents');
    const flowPromise = runSessionHandoffUiFlow({
      execute: execute as any,
      sessionId: 'sess_1',
      targetMachineId: 'machine_target',
      context: { defaultSessionId: 'sess_1', surface: 'ui', placement: 'session_info' } as any,
    });

    publishSessionHandoffProgress({
      sessionId: 'sess_1',
      targetMachineId: 'machine_target',
      transitionRevision: 7,
      status: {
        handoffId: 'handoff_interrupted_1',
        jobId: 'prepare_job_1',
        status: 'awaiting_user_resume',
        phase: 'staging_target',
        recoveryActions: [],
      },
    });
    const interruptedUpdate = modalUpdateMock.mock.calls.at(-1)?.[1] as {
      onResume?: () => Promise<void>;
    };
    await interruptedUpdate.onResume?.();

    expect(modalAlertMock).toHaveBeenCalledWith(
      'sessionHandoff.failure.title',
      'The interrupted handoff changed before Resume was accepted.',
    );
    expect(modalUpdateMock).not.toHaveBeenCalledWith(
      'modal_1',
      expect.objectContaining({
        status: expect.objectContaining({ status: 'in_progress' }),
      }),
    );

    actionResolution.current?.({ ok: true, handoffId: 'handoff_interrupted_1' });
    await flowPromise;
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
      context: { defaultSessionId: 'sess_1', surface: 'ui', placement: 'session_info' } as any,
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
      context: { defaultSessionId: 'sess_1', surface: 'ui', placement: 'session_info' } as any,
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
      context: { defaultSessionId: 'sess_3', surface: 'ui', placement: 'session_info' } as any,
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

  it('keeps recovery failures inside the committed recovery phase', async () => {
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
      context: { defaultSessionId: 'sess_4', surface: 'ui', placement: 'session_info' } as any,
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
    expect(openSessionHandoffFailureRecoveryModalMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ details: 'source_resume_failed' }),
    );
    expect(modalConfirmMock).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, handled: true });
  });

  it('contains an unexpected recovery rejection without rerunning the whole handoff', async () => {
    executeSessionHandoffActionMock.mockResolvedValueOnce({
      ok: false,
      error: 'cleanup_pending',
      recovery: {
        handoffId: 'handoff_committed',
        actions: ['retry_source_cleanup'],
      },
    });
    openSessionHandoffFailureRecoveryModalMock
      .mockResolvedValueOnce('retry_source_cleanup')
      .mockResolvedValueOnce(null);
    performSessionHandoffRecoveryActionMock.mockRejectedValueOnce(new Error('finalizer rejected'));

    const { runSessionHandoffUiFlow } = await import('./runSessionHandoffUiFlow');
    await expect(runSessionHandoffUiFlow({
      execute: vi.fn() as any,
      sessionId: 'sess_committed',
      targetMachineId: 'machine_target',
      context: { defaultSessionId: 'sess_committed', surface: 'ui', placement: 'session_info' } as any,
    })).resolves.toEqual({ ok: false, handled: true });

    expect(executeSessionHandoffActionMock).toHaveBeenCalledTimes(1);
    expect(performSessionHandoffRecoveryActionMock).toHaveBeenCalledTimes(1);
    expect(openSessionHandoffFailureRecoveryModalMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ details: 'finalizer rejected' }),
    );
    expect(modalConfirmMock).not.toHaveBeenCalled();
  });
});
