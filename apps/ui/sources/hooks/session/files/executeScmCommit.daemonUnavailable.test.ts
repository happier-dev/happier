import { describe, expect, it, vi } from 'vitest';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { installSessionFilesHookCommonModuleMocks } from './sessionFilesHookTestHelpers';

const modalAlert = vi.hoisted(() => vi.fn());
const sessionScmCommitCreate = vi.hoisted(() => vi.fn());
const withSessionProjectScmOperationLock = vi.hoisted(() => vi.fn(async (input: any) => {
  await input.run();
  return { started: true, message: '' };
}));

installSessionFilesHookCommonModuleMocks({
  modal: async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
      spies: {
        alert: modalAlert,
      },
    }).module;
  },
  storage: async (importOriginal) => importOriginal(),
});

vi.mock('@/scm/operations/withOperationLock', () => ({
  withSessionProjectScmOperationLock,
}));

vi.mock('@/sync/ops', () => ({
  sessionScmCommitCreate,
}));

vi.mock('@/scm/scmStatusSync', () => ({
  scmStatusSync: {
    invalidateFromMutationAndAwait: vi.fn(async () => {}),
  },
}));

describe('executeScmCommit (daemon unavailable)', () => {
  it('shows daemon-unavailable alert with Retry when commit RPC backend is unavailable', async () => {
    modalAlert.mockReset();
    sessionScmCommitCreate.mockReset();

    sessionScmCommitCreate.mockResolvedValueOnce({
      success: false,
      errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE,
      error: 'RPC method not available',
    });

    const { executeScmCommit } = await import('./executeScmCommit');

    const result = await executeScmCommit({
      sessionId: 's1',
      commitMessage: 'feat: test',
      scmCommitStrategy: 'git_staging',
      commitSelectionPaths: [],
      commitSelectionPatches: [],
      loadCommitHistory: vi.fn(async () => {}),
      refreshScmData: vi.fn(async () => {}),
      setScmOperationBusy: vi.fn(),
      setScmOperationStatus: vi.fn(),
      tracking: null,
    });

    expect(result.ok).toBe(false);
    expect(modalAlert).toHaveBeenCalled();
    const [title, message, buttons] = modalAlert.mock.calls[0] ?? [];
    expect(title).toBe('errors.daemonUnavailableTitle');
    expect(String(message ?? '')).toContain('errors.daemonUnavailableBody');
    expect(Array.isArray(buttons)).toBe(true);
    expect((buttons as any[]).some((b) => b?.text === 'common.retry')).toBe(true);
  });

  it('does not retry when caller indicates it is unmounted', async () => {
    modalAlert.mockReset();
    sessionScmCommitCreate.mockReset();

    sessionScmCommitCreate.mockResolvedValueOnce({
      success: false,
      errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE,
      error: 'RPC method not available',
    });

    const { executeScmCommit } = await import('./executeScmCommit');

    const result = await executeScmCommit({
      sessionId: 's1',
      commitMessage: 'feat: test',
      scmCommitStrategy: 'git_staging',
      commitSelectionPaths: [],
      commitSelectionPatches: [],
      loadCommitHistory: vi.fn(async () => {}),
      refreshScmData: vi.fn(async () => {}),
      setScmOperationBusy: vi.fn(),
      setScmOperationStatus: vi.fn(),
      tracking: null,
      shouldContinue: () => false,
    });

    expect(result.ok).toBe(false);
    const [_title, _message, buttons] = modalAlert.mock.calls[0] ?? [];
    const retry = (buttons as any[]).find((b) => b?.text === 'common.retry');
    expect(retry).toBeTruthy();

    retry.onPress();
    await new Promise((r) => setTimeout(r, 0));

    expect(sessionScmCommitCreate).toHaveBeenCalledTimes(1);
  });

  it('keeps selected full-file paths when atomic line-selection patches are present', async () => {
    modalAlert.mockReset();
    sessionScmCommitCreate.mockReset();

    sessionScmCommitCreate.mockResolvedValueOnce({
      success: true,
      commitSha: 'abc123',
    });

    const { executeScmCommit } = await import('./executeScmCommit');

    const result = await executeScmCommit({
      sessionId: 's1',
      commitMessage: 'feat: test',
      scmCommitStrategy: 'atomic',
      commitSelectionPaths: ['b.txt'],
      commitSelectionPatches: [
        {
          path: 'a.txt',
          patch: [
            'diff --git a/a.txt b/a.txt',
            'index df967b9..9f0e218 100644',
            '--- a/a.txt',
            '+++ b/a.txt',
            '@@ -1 +1,2 @@',
            ' base',
            '+line-one',
            '',
          ].join('\n'),
        },
      ],
      loadCommitHistory: vi.fn(async () => {}),
      refreshScmData: vi.fn(async () => {}),
      setScmOperationBusy: vi.fn(),
      setScmOperationStatus: vi.fn(),
      tracking: null,
    });

    expect(result.ok).toBe(true);
    expect(sessionScmCommitCreate).toHaveBeenCalledTimes(1);
    expect(sessionScmCommitCreate).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        message: 'feat: test',
        scope: {
          kind: 'paths',
          include: ['b.txt'],
        },
        patches: expect.any(Array),
      }),
    );
  });

  it('refreshes repository data through the caller refresh path before finishing a successful commit', async () => {
    modalAlert.mockReset();
    sessionScmCommitCreate.mockReset();
    const events: string[] = [];
    const refreshScmData = vi.fn(async () => {
      events.push('refresh');
    });
    const loadCommitHistory = vi.fn(async () => {
      events.push('history');
    });
    const setScmOperationBusy = vi.fn((busy: boolean) => {
      events.push(`busy:${String(busy)}`);
    });

    sessionScmCommitCreate.mockResolvedValueOnce({
      success: true,
      commitSha: 'abc123',
    });

    const { executeScmCommit } = await import('./executeScmCommit');

    const result = await executeScmCommit({
      sessionId: 's1',
      commitMessage: 'feat: test',
      scmCommitStrategy: 'git_staging',
      commitSelectionPaths: ['a.txt'],
      commitSelectionPatches: [],
      loadCommitHistory,
      refreshScmData,
      setScmOperationBusy,
      setScmOperationStatus: vi.fn(),
      tracking: null,
    });

    expect(result.ok).toBe(true);
    expect(refreshScmData).toHaveBeenCalledTimes(1);
    expect(loadCommitHistory).toHaveBeenCalledTimes(1);
    expect(events.indexOf('refresh')).toBeGreaterThan(events.indexOf('busy:true'));
    expect(events.indexOf('history')).toBeGreaterThan(events.indexOf('refresh'));
    expect(events.at(-1)).toBe('busy:false');
  });
});
