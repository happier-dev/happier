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
      context: { defaultSessionId: 'sess_1', surface: 'ui_button', placement: 'session_info' } as any,
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

  it('surfaces recovery action failures through the retry confirm with the recovery error', async () => {
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
    openSessionHandoffFailureRecoveryModalMock.mockResolvedValueOnce('restart_on_source');
    performSessionHandoffRecoveryActionMock.mockResolvedValueOnce({ ok: false, error: 'source_resume_failed' });
    modalConfirmMock.mockResolvedValueOnce(false);

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
    expect(modalConfirmMock).toHaveBeenCalledWith(
      'sessionHandoff.failure.title',
      'source_resume_failed',
      {
        cancelText: 'common.cancel',
        confirmText: 'common.retry',
      },
    );
    expect(result).toEqual({ ok: false, handled: true });
  });
});
