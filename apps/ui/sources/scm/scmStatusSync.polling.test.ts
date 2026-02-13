import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

const getStateMock = vi.hoisted(() => vi.fn());
const applyScmStatusMock = vi.hoisted(() => vi.fn());
const updateSnapshotMock = vi.hoisted(() => vi.fn());
const updateSnapshotErrorMock = vi.hoisted(() => vi.fn());
const pruneCommitSelectionPathsMock = vi.hoisted(() => vi.fn());
const pruneTouchedPathsMock = vi.hoisted(() => vi.fn());
const pruneCommitSelectionPatchesMock = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
  },
}));

vi.mock('@/sync/domains/state/storage', () => ({
  storage: {
    getState: getStateMock,
  },
}));

const fetchSnapshotForSessionMock = vi.hoisted(() => vi.fn());
vi.mock('./scmRepositoryService', () => ({
  scmRepositoryService: {
    fetchSnapshotForSession: fetchSnapshotForSessionMock,
  },
  snapshotToScmStatus: vi.fn(),
}));

describe('ScmStatusSync polling', () => {
  beforeEach(() => {
    vi.useRealTimers();
    getStateMock.mockReset();
    applyScmStatusMock.mockReset();
    updateSnapshotMock.mockReset();
    updateSnapshotErrorMock.mockReset();
    pruneCommitSelectionPathsMock.mockReset();
    pruneTouchedPathsMock.mockReset();
    pruneCommitSelectionPatchesMock.mockReset();
    fetchSnapshotForSessionMock.mockReset();
  });

  it('suspends background polling when scm snapshot fails with feature unsupported', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    getStateMock.mockReturnValue({
      sessions: {
        s1: { id: 's1', metadata: { machineId: 'machine-a', path: '/repo' } },
      },
      applyScmStatus: applyScmStatusMock,
      updateSessionProjectScmSnapshot: updateSnapshotMock,
      updateSessionProjectScmSnapshotError: updateSnapshotErrorMock,
      pruneSessionProjectScmTouchedPaths: pruneTouchedPathsMock,
      pruneSessionProjectScmCommitSelectionPaths: pruneCommitSelectionPathsMock,
      pruneSessionProjectScmCommitSelectionPatches: pruneCommitSelectionPatchesMock,
    });

    const err = Object.assign(new Error('RPC method not available'), {
      scmErrorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
    });
    fetchSnapshotForSessionMock.mockRejectedValue(err);

    const { ScmStatusSync } = await import('./scmStatusSync');

    const syncer = new ScmStatusSync();
    const sync = syncer.getSync('s1');
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);

    await sync.invalidateAndAwait();

    // Does not schedule another background poll after the unsupported capability is detected.
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);

    const lastCall = updateSnapshotErrorMock.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe('s1');
    expect(lastCall?.[1]).toMatchObject({
      message: 'RPC method not available',
      errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
    });

    setTimeoutSpy.mockRestore();
  });
});

