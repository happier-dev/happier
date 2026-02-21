import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const modalAlert = vi.hoisted(() => vi.fn());
const sessionScmChangeInclude = vi.hoisted(() => vi.fn());
const sessionScmChangeExclude = vi.hoisted(() => vi.fn());
const withSessionProjectScmOperationLock = vi.hoisted(() => vi.fn(async (input: any) => {
  await input.run();
  return { started: true, message: '' };
}));

vi.mock('@/modal', () => ({
  Modal: {
    alert: modalAlert,
    confirm: vi.fn(async () => true),
    prompt: vi.fn(async () => null),
  },
}));

vi.mock('@/text', () => ({
  t: (key: string) => key,
}));

vi.mock('@/sync/ops', () => ({
  sessionScmChangeInclude,
  sessionScmChangeExclude,
}));

vi.mock('@/scm/scmPatchSelection', () => ({
  buildPatchFromSelectedDiffLines: () => 'patch',
}));

vi.mock('@/scm/core/operationPolicy', () => ({
  evaluateScmOperationPreflight: () => ({ allowed: true, message: '' }),
}));

vi.mock('@/scm/operations/withOperationLock', () => ({
  withSessionProjectScmOperationLock,
}));

vi.mock('@/scm/scmStatusSync', () => ({
  scmStatusSync: {
    invalidateFromMutationAndAwait: vi.fn(async () => {}),
  },
}));

vi.mock('@/scm/operations/reporting', () => ({
  reportSessionScmOperation: () => {},
  trackBlockedScmOperation: () => {},
}));

vi.mock('@/track', () => ({
  tracking: null,
}));

describe('useFileScmStageActions (daemon unavailable)', () => {
  beforeEach(() => {
    modalAlert.mockReset();
    sessionScmChangeInclude.mockReset();
    sessionScmChangeExclude.mockReset();
    withSessionProjectScmOperationLock.mockClear();
  });

  it('shows daemon-unavailable alert when include/exclude RPC backend is unavailable', async () => {
    sessionScmChangeInclude.mockResolvedValueOnce({
      success: false,
      errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE,
      error: 'RPC method not available',
    });

    const { useFileScmStageActions } = await import('./useFileScmStageActions');

    const props: Parameters<typeof useFileScmStageActions>[0] = {
      sessionId: 's1',
      sessionPath: '/tmp',
      filePath: 'a.txt',
      scmSnapshot: null,
      scmWriteEnabled: true,
      scmCommitStrategy: 'git_staging',
      includeExcludeEnabled: true,
      diffMode: 'pending',
      diffContent: 'diff',
      lineSelectionEnabled: true,
      selectedLineIndexes: new Set([1]),
      refreshAll: vi.fn(async () => {}),
      setSelectedLineIndexes: vi.fn(),
    };

    let current: ReturnType<typeof useFileScmStageActions> | null = null;
    let tree: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        React.createElement(() => {
          current = useFileScmStageActions(props);
          return React.createElement('View');
        }),
      );
    });

    await act(async () => {
      await current!.applySelectedLines();
    });

    expect(modalAlert).toHaveBeenCalled();
    const [title, message, buttons] = modalAlert.mock.calls[0] ?? [];
    expect(title).toBe('errors.daemonUnavailableTitle');
    expect(String(message ?? '')).toContain('errors.daemonUnavailableBody');
    expect(Array.isArray(buttons)).toBe(true);
    const retry = (buttons as any[]).find((b) => b?.text === 'common.retry');
    expect(retry).toBeTruthy();

    act(() => {
      tree.unmount();
    });

    await act(async () => {
      retry.onPress();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(sessionScmChangeInclude).toHaveBeenCalledTimes(1);
  });
});
