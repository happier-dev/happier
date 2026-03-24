import { describe, expect, it, vi } from 'vitest';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import { installScmOperationsCommonModuleMocks } from './scmOperationsTestHelpers';

const modalAlert = vi.hoisted(() => vi.fn());
const modalConfirm = vi.hoisted(() => vi.fn());
const sessionScmChangeDiscard = vi.hoisted(() => vi.fn());
const withSessionProjectScmOperationLock = vi.hoisted(() => vi.fn(async (input: any) => {
  await input.run();
  return { started: true, message: '' };
}));
const evaluateScmOperationPreflight = vi.hoisted(() => vi.fn(() => ({ allowed: true, message: '' })));

installScmOperationsCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: modalAlert,
                confirm: modalConfirm,
            },
        }).module;
    },
});

vi.mock('@/sync/ops', () => ({
  sessionScmChangeDiscard,
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

describe('applyFileDiscardAction (daemon unavailable)', () => {
  it('shows a confirm prompt and does not call RPC when user cancels', async () => {
    modalAlert.mockReset();
    modalConfirm.mockReset();
    sessionScmChangeDiscard.mockReset();

    modalConfirm.mockResolvedValueOnce(false);

    const { applyFileDiscardAction } = await import('./applyFileDiscardAction');

    await applyFileDiscardAction({
      sessionId: 's1',
      sessionPath: '/tmp',
      file: { fullPath: 'a.txt', status: 'modified' },
      snapshot: null,
      scmWriteEnabled: true,
      commitStrategy: 'git_staging',
      surface: 'file',
    } as any);

    expect(modalConfirm).toHaveBeenCalled();
    expect(sessionScmChangeDiscard).not.toHaveBeenCalled();
  });

  it('shows daemon-unavailable alert with Retry when SCM RPC backend is unavailable', async () => {
    modalAlert.mockReset();
    modalConfirm.mockReset();
    sessionScmChangeDiscard.mockReset();

    modalConfirm.mockResolvedValueOnce(true);
    sessionScmChangeDiscard.mockResolvedValueOnce({
      success: false,
      errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE,
      error: 'RPC method not available',
    });

    const { applyFileDiscardAction } = await import('./applyFileDiscardAction');

    await applyFileDiscardAction({
      sessionId: 's1',
      sessionPath: '/tmp',
      file: { fullPath: 'a.txt', status: 'modified' },
      snapshot: null,
      scmWriteEnabled: true,
      commitStrategy: 'git_staging',
      surface: 'file',
    } as any);

    expect(modalAlert).toHaveBeenCalled();
    const [title, message, buttons] = modalAlert.mock.calls[0] ?? [];
    expect(title).toBe('errors.daemonUnavailableTitle');
    expect(String(message ?? '')).toContain('errors.daemonUnavailableBody');
    expect(Array.isArray(buttons)).toBe(true);
    expect((buttons as any[]).some((b) => b?.text === 'common.retry')).toBe(true);
  });
});
