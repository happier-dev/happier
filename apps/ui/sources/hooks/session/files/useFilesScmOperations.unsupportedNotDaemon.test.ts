import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const modalAlert = vi.hoisted(() => vi.fn());
const sessionScmRemotePush = vi.hoisted(() => vi.fn());
const withSessionProjectScmOperationLock = vi.hoisted(() => vi.fn(async (input: any) => {
  await input.run();
  return { started: true, message: '' };
}));

vi.mock('@/modal', () => ({
  Modal: {
    alert: modalAlert,
    confirm: vi.fn(async () => true),
  },
}));

vi.mock('@/text', () => ({
  t: (key: string) => key,
}));

vi.mock('@/sync/ops', () => ({
  sessionScmRemoteFetch: vi.fn(),
  sessionScmRemotePull: vi.fn(),
  sessionScmRemotePush,
}));

vi.mock('@/scm/operations/withOperationLock', () => ({
  withSessionProjectScmOperationLock,
}));

vi.mock('@/scm/core/operationPolicy', () => ({
  evaluateScmOperationPreflight: () => ({ allowed: true, message: '' }),
}));

vi.mock('@/scm/operations/remoteTarget', () => ({
  inferRemoteTargetFromSnapshot: () => ({ remote: 'origin', branch: 'main' }),
}));

vi.mock('@/scm/operations/remoteFeedback', () => ({
  buildRemoteConfirmDialog: () => ({ title: 'title', body: 'body', confirmText: 'ok', cancelText: 'cancel' }),
  buildRemoteOperationBusyLabel: () => 'busy',
  buildRemoteOperationSuccessDetail: () => 'success',
  buildNonFastForwardFetchPromptDialog: () => ({ title: 't', body: 'b', confirmText: 'c', cancelText: 'x' }),
}));

vi.mock('@/scm/operations/reporting', () => ({
  reportSessionScmOperation: () => {},
  trackBlockedScmOperation: () => {},
}));

vi.mock('@/track', () => ({
  tracking: null,
}));

vi.mock('@/components/sessions/files/commit/showScmCommitMessageEditorModal', () => ({
  showScmCommitMessageEditorModal: vi.fn(async () => 'feat: commit'),
}));

describe('useFilesScmOperations (unsupported is not daemon unavailable)', () => {
  beforeEach(() => {
    modalAlert.mockReset();
    sessionScmRemotePush.mockReset();
    withSessionProjectScmOperationLock.mockClear();
  });

  it('does not show daemon-unavailable alert for FEATURE_UNSUPPORTED even if error text is method-not-available', async () => {
    sessionScmRemotePush.mockResolvedValueOnce({
      success: false,
      errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
      error: 'RPC method not available',
    });

    const { useFilesScmOperations } = await import('./useFilesScmOperations');

    const refreshScmData = vi.fn(async () => {});
    const loadCommitHistory = vi.fn(async () => {});

    let current: ReturnType<typeof useFilesScmOperations> | null = null;
    let tree: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(React.createElement(() => {
        current = useFilesScmOperations({
          sessionId: 's1',
          sessionPath: '/tmp',
          scmSnapshot: null,
          scmWriteEnabled: true,
          scmCommitStrategy: 'git_staging',
          scmRemoteConfirmPolicy: 'never',
          scmPushRejectPolicy: 'prompt_fetch',
          refreshScmData,
          loadCommitHistory,
        });
        return React.createElement('View');
      }));
    });

    await act(async () => {
      await current!.runRemoteOperation('push');
    });

    expect(modalAlert).toHaveBeenCalled();
    const [title] = modalAlert.mock.calls[0] ?? [];
    expect(title).toBe('common.error');

    act(() => {
      tree.unmount();
    });
  });
});

