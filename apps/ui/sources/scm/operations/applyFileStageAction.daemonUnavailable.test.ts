import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol/scm/operationError';

import type { IModal } from '@/modal';
import { storage } from '@/sync/domains/state/storage';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createWritableScmSnapshot } from './scmOperationsTestHelpers';

const modalAlert = vi.hoisted(() => vi.fn<IModal['alert']>());
const sessionScmChangeInclude = vi.hoisted(() => vi.fn());
const sessionScmChangeExclude = vi.hoisted(() => vi.fn());

// Top-level (hoisted) so the spies are wired before the static storage import loads the modal module.
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { alert: modalAlert } }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

// The SCM write facade is the system boundary; the operation lock and preflight policy run for real.
vi.mock('@/sync/ops', () => ({
  sessionScmChangeInclude,
  sessionScmChangeExclude,
}));

describe('applyFileStageAction (daemon unavailable)', () => {
  const initialStorageState = storage.getState();

  beforeEach(() => {
    storage.setState(initialStorageState, true);
    projectManager.clear();
    const base = createSessionFixture();
    storage.setState({ sessions: { s1: createSessionFixture({ id: 's1', metadata: { ...base.metadata!, path: '/repo' } }) } });
    modalAlert.mockReset();
    sessionScmChangeInclude.mockReset();
    sessionScmChangeExclude.mockReset();
  });

  it.each([
    { caller: 'a mounted caller', shouldContinue: undefined, attempts: 2 },
    { caller: 'a caller that has unmounted', shouldContinue: () => false, attempts: 1 },
  ])('shows the daemon-unavailable alert with Retry, which stages again only for $caller', async ({ shouldContinue, attempts }) => {
    sessionScmChangeInclude.mockResolvedValue({
      success: false,
      errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE,
      error: 'RPC method not available',
    });

    const { applyFileStageAction } = await import('./applyFileStageAction');

    await applyFileStageAction({
      sessionId: 's1',
      sessionPath: '/repo',
      filePath: 'a.txt',
      snapshot: createWritableScmSnapshot(),
      scmWriteEnabled: true,
      commitStrategy: 'git_staging',
      stage: true,
      surface: 'file',
      ...(shouldContinue ? { shouldContinue } : {}),
    });

    expect(modalAlert).toHaveBeenCalled();
    const [title, message, buttons] = modalAlert.mock.calls[0] ?? [];
    expect(title).toBe('errors.daemonUnavailableTitle');
    expect(String(message ?? '')).toContain('errors.daemonUnavailableBody');
    const retry = buttons?.find((button) => button.text === 'common.retry');
    expect(retry).toBeTruthy();

    retry?.onPress?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sessionScmChangeInclude).toHaveBeenCalledTimes(attempts);
    expect(storage.getState().getSessionProjectScmInFlightOperation('s1')).toBeNull();
  });
});
