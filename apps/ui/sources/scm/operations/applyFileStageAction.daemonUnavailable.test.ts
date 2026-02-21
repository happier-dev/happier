import { describe, expect, it, vi } from 'vitest';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

const modalAlert = vi.hoisted(() => vi.fn());
const sessionScmChangeInclude = vi.hoisted(() => vi.fn());
const sessionScmChangeExclude = vi.hoisted(() => vi.fn());
const withSessionProjectScmOperationLock = vi.hoisted(() => vi.fn(async (input: any) => {
  await input.run();
  return { started: true, message: '' };
}));
const evaluateScmOperationPreflight = vi.hoisted(() => vi.fn(() => ({ allowed: true, message: '' })));

vi.mock('@/modal', () => ({
  Modal: {
    alert: modalAlert,
  },
}));

vi.mock('@/text', () => ({
  t: (key: string) => key,
}));

vi.mock('@/sync/ops', () => ({
  sessionScmChangeInclude,
  sessionScmChangeExclude,
}));

vi.mock('@/scm/operations/withOperationLock', () => ({
  withSessionProjectScmOperationLock,
}));

vi.mock('@/scm/core/operationPolicy', () => ({
  evaluateScmOperationPreflight,
}));

vi.mock('@/scm/scmStatusSync', () => ({
  scmStatusSync: {
    invalidateFromMutationAndAwait: vi.fn(async () => {}),
  },
}));

describe('applyFileStageAction (daemon unavailable)', () => {
  it('shows daemon-unavailable alert with Retry when SCM RPC backend is unavailable', async () => {
    modalAlert.mockReset();
    sessionScmChangeInclude.mockReset();
    sessionScmChangeExclude.mockReset();

    sessionScmChangeInclude.mockResolvedValueOnce({
      success: false,
      errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE,
      error: 'RPC method not available',
    });

    const { applyFileStageAction } = await import('./applyFileStageAction');

    await applyFileStageAction({
      sessionId: 's1',
      sessionPath: '/tmp',
      filePath: 'a.txt',
      snapshot: null,
      scmWriteEnabled: true,
      commitStrategy: 'git_staging',
      stage: true,
      surface: 'file',
    });

    expect(modalAlert).toHaveBeenCalled();
    const [title, message, buttons] = modalAlert.mock.calls[0] ?? [];
    expect(title).toBe('errors.daemonUnavailableTitle');
    expect(String(message ?? '')).toContain('errors.daemonUnavailableBody');
    expect(Array.isArray(buttons)).toBe(true);
    expect((buttons as any[]).some((b) => b?.text === 'common.retry')).toBe(true);
  });

  it('does not retry when caller indicates it is unmounted', async () => {
    modalAlert.mockReset();
    sessionScmChangeInclude.mockReset();

    sessionScmChangeInclude.mockResolvedValueOnce({
      success: false,
      errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE,
      error: 'RPC method not available',
    });

    const { applyFileStageAction } = await import('./applyFileStageAction');

    await applyFileStageAction({
      sessionId: 's1',
      sessionPath: '/tmp',
      filePath: 'a.txt',
      snapshot: null,
      scmWriteEnabled: true,
      commitStrategy: 'git_staging',
      stage: true,
      surface: 'file',
      shouldContinue: () => false,
    } as any);

    expect(sessionScmChangeInclude).toHaveBeenCalledTimes(1);
    const [_title, _message, buttons] = modalAlert.mock.calls[0] ?? [];
    const retry = (buttons as any[]).find((b) => b?.text === 'common.retry');
    expect(retry).toBeTruthy();

    retry.onPress();
    await new Promise((r) => setTimeout(r, 0));

    expect(sessionScmChangeInclude).toHaveBeenCalledTimes(1);
  });
});
