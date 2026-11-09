import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol/scm/operationError';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { IModal } from '@/modal';
import { storage } from '@/sync/domains/state/storage';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createWritableScmSnapshot } from './scmOperationsTestHelpers';

const modalAlert = vi.hoisted(() => vi.fn<IModal['alert']>());
const modalConfirm = vi.hoisted(() => vi.fn<IModal['confirm']>());
const sessionScmChangeDiscard = vi.hoisted(() => vi.fn());
const machineRpc = vi.hoisted(() => vi.fn());

// Top-level (hoisted) so the spies are wired before the static storage import loads the modal module.
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { alert: modalAlert, confirm: modalConfirm } }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

// The SCM write facade and the Machine RPC transport (the post-write status read) are the system boundaries;
// the operation lock, preflight policy, repository refresh and operation log run for real.
vi.mock('@/sync/ops', () => ({
  sessionScmChangeDiscard,
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
  const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
  return createServerScopedMachineRpcBoundaryMock(machineRpc);
});

const discardInput = {
  sessionId: 's1',
  sessionPath: '/repo',
  file: { fullPath: 'a.txt', status: 'modified' },
  snapshot: createWritableScmSnapshot(),
  scmWriteEnabled: true,
  commitStrategy: 'git_staging',
  surface: 'file',
} as const;

describe('applyFileDiscardAction (daemon unavailable)', () => {
  const initialStorageState = storage.getState();

  beforeEach(() => {
    storage.setState(initialStorageState, true);
    projectManager.clear();
    const machine = createMachineFixture({ id: 'machine-1' });
    const base = createSessionFixture();
    storage.setState({
      machines: { [machine.id]: machine },
      sessions: { s1: createSessionFixture({ id: 's1', metadata: { ...base.metadata!, machineId: machine.id, path: '/repo' } }) },
    });
    modalAlert.mockReset();
    modalConfirm.mockReset();
    sessionScmChangeDiscard.mockReset();
    machineRpc.mockReset().mockImplementation(async (params: { method: string }) => params.method === RPC_METHODS.SCM_STATUS_SNAPSHOT
      ? { success: true, snapshot: createWritableScmSnapshot() }
      : { success: false, errorCode: 'BACKEND_UNAVAILABLE', error: `unexpected ${params.method}` });
  });
  afterEach(async () => {
    (await import('@/scm/scmStatusSync')).scmStatusSync.stop('s1');
  });

  it('does not add a caller confirmation before the discard Action', async () => {
    sessionScmChangeDiscard.mockResolvedValueOnce({ success: true });

    const { applyFileDiscardAction } = await import('./applyFileDiscardAction');

    await applyFileDiscardAction(discardInput);

    expect(modalConfirm).not.toHaveBeenCalled();
    expect(sessionScmChangeDiscard).toHaveBeenCalledTimes(1);
    expect(storage.getState().getSessionProjectScmOperationLog('s1')[0]).toMatchObject({ operation: 'discard', status: 'success', path: 'a.txt' });
  });

  it('shows daemon-unavailable alert with Retry when SCM RPC backend is unavailable', async () => {
    sessionScmChangeDiscard.mockResolvedValueOnce({
      success: false,
      errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE,
      error: 'RPC method not available',
    });

    const { applyFileDiscardAction } = await import('./applyFileDiscardAction');

    await applyFileDiscardAction(discardInput);

    expect(modalAlert).toHaveBeenCalled();
    const [title, message, buttons] = modalAlert.mock.calls[0] ?? [];
    expect(title).toBe('errors.daemonUnavailableTitle');
    expect(String(message ?? '')).toContain('errors.daemonUnavailableBody');
    expect(buttons?.some((button) => button.text === 'common.retry')).toBe(true);
  });

  it('stays quiet when the person declines the Action confirmation', async () => {
    // What the real SCM facade returns for a declined in-place confirmation.
    const { normalizeUiScmFacadeResult } = await import('@/sync/ops/scm/scmActionInvocation');
    sessionScmChangeDiscard.mockResolvedValueOnce(
      normalizeUiScmFacadeResult({ success: false, errorCode: 'approval_canceled', error: 'approval_canceled' }),
    );

    const { applyFileDiscardAction } = await import('./applyFileDiscardAction');

    await applyFileDiscardAction(discardInput);

    expect(sessionScmChangeDiscard).toHaveBeenCalledTimes(1);
    expect(modalAlert).not.toHaveBeenCalled();
    expect(storage.getState().getSessionProjectScmOperationLog('s1')).toEqual([]);
  });
});
