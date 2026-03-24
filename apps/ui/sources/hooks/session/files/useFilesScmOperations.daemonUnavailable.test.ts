import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { flushHookEffects, renderHook } from '@/dev/testkit';
import { installSessionFilesHookCommonModuleMocks } from './sessionFilesHookTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const modalAlert = vi.hoisted(() => vi.fn());
const modalConfirm = vi.hoisted(() => vi.fn(async () => true));
const sessionScmRemoteFetch = vi.hoisted(() => vi.fn());
const sessionScmRemotePull = vi.hoisted(() => vi.fn());
const sessionScmRemotePush = vi.hoisted(() => vi.fn());
const withSessionProjectScmOperationLock = vi.hoisted(() => vi.fn(async (input: any) => {
  await input.run();
  return { started: true, message: '' };
}));
const originalConsoleError = console.error;
let consoleErrorSpy: ReturnType<typeof vi.spyOn> | null = null;

installSessionFilesHookCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: modalAlert,
                confirm: modalConfirm,
            },
        }).module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
    storage: async (importOriginal) => importOriginal(),
});

vi.mock('@/sync/ops', () => ({
  sessionScmRemoteFetch,
  sessionScmRemotePull,
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

describe('useFilesScmOperations (daemon unavailable)', () => {
  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        const [firstArg] = args;
        if (typeof firstArg === 'string' && firstArg.includes('not wrapped in act')) {
            return;
        }
        originalConsoleError(...args);
    });
    modalAlert.mockReset();
    modalConfirm.mockReset();
    sessionScmRemoteFetch.mockReset();
    sessionScmRemotePull.mockReset();
    sessionScmRemotePush.mockReset();
    withSessionProjectScmOperationLock.mockClear();
  });

  afterEach(() => {
    consoleErrorSpy?.mockRestore();
    consoleErrorSpy = null;
  });

    it('shows daemon-unavailable alert with Retry when remote operation fails with RPC method-not-available', async () => {
        sessionScmRemotePush.mockResolvedValueOnce({
            success: false,
      errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE,
      error: 'RPC method not available',
    });

    const { useFilesScmOperations } = await import('./useFilesScmOperations');

        const refreshScmData = vi.fn(async () => {});
        const loadCommitHistory = vi.fn(async () => {});

        const hook = await renderHook(() => useFilesScmOperations({
            sessionId: 's1',
            sessionPath: '/tmp',
            scmSnapshot: null,
            scmWriteEnabled: true,
            scmCommitStrategy: 'git_staging',
            scmRemoteConfirmPolicy: 'never',
            scmPushRejectPolicy: 'prompt_fetch',
            refreshScmData,
            loadCommitHistory,
        }));

        await act(async () => {
            await hook.getCurrent().runRemoteOperation('push');
        });
        await flushHookEffects();

    expect(modalAlert).toHaveBeenCalled();
    const [title, message, buttons] = modalAlert.mock.calls[0] ?? [];
    expect(title).toBe('errors.daemonUnavailableTitle');
    expect(String(message ?? '')).toContain('errors.daemonUnavailableBody');
    expect(Array.isArray(buttons)).toBe(true);

        await hook.unmount();
    });

  it('does not retry after unmount when pressing Retry', async () => {
    sessionScmRemotePush.mockResolvedValueOnce({
      success: false,
      errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE,
      error: 'RPC method not available',
    });

        const { useFilesScmOperations } = await import('./useFilesScmOperations');

        const refreshScmData = vi.fn(async () => {});
        const loadCommitHistory = vi.fn(async () => {});

        const hook = await renderHook(() => useFilesScmOperations({
            sessionId: 's1',
            sessionPath: '/tmp',
            scmSnapshot: null,
            scmWriteEnabled: true,
            scmCommitStrategy: 'git_staging',
            scmRemoteConfirmPolicy: 'never',
            scmPushRejectPolicy: 'prompt_fetch',
            refreshScmData,
            loadCommitHistory,
        }));

        await hook.getCurrent().runRemoteOperation('push');

        const [_title, _message, buttons] = modalAlert.mock.calls[0] ?? [];
        const retry = (buttons as any[]).find((b) => b?.text === 'common.retry');
        expect(retry).toBeTruthy();

        await hook.unmount();

        await act(async () => {
            retry.onPress();
            await new Promise((r) => setTimeout(r, 0));
        });
        await flushHookEffects();

        expect(sessionScmRemotePush).toHaveBeenCalledTimes(1);
  });
});
