import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

const getStateMock = vi.hoisted(() => vi.fn());
const applyScmStatusMock = vi.hoisted(() => vi.fn());
const updateSnapshotMock = vi.hoisted(() => vi.fn());
const updateSnapshotErrorMock = vi.hoisted(() => vi.fn());
const pruneCommitSelectionPathsMock = vi.hoisted(() => vi.fn());
const pruneTouchedPathsMock = vi.hoisted(() => vi.fn());
const pruneCommitSelectionPatchesMock = vi.hoisted(() => vi.fn());
const getSnapshotErrorMock = vi.hoisted(() => vi.fn(() => null));
const clearSearchCacheForProjectMock = vi.hoisted(() => vi.fn(async () => {}));

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

vi.mock('./statusSync/projectState', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./statusSync/projectState')>();
  return {
    ...actual,
    clearSearchCacheForProject: (...args: any[]) => (clearSearchCacheForProjectMock as any).apply(null, args),
  };
});

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
    getSnapshotErrorMock.mockReset();
    clearSearchCacheForProjectMock.mockClear();
  });

  function buildRepoSnapshot(params: { fetchedAt: number; head?: string }) {
    return {
      projectKey: 'machine-a:/repo',
      fetchedAt: params.fetchedAt,
      repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
      capabilities: { readStatus: true },
      branch: { head: params.head ?? 'main', upstream: null, ahead: 0, behind: 0, detached: false },
      stashCount: 0,
      hasConflicts: false,
      entries: [
        {
          path: 'src/a.ts',
          previousPath: null,
          kind: 'modified',
          includeStatus: 'excluded',
          pendingStatus: 'modified',
          hasIncludedDelta: false,
          hasPendingDelta: true,
          stats: {
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 1,
            pendingRemoved: 1,
            isBinary: false,
          },
        },
      ],
      totals: {
        includedFiles: 0,
        pendingFiles: 1,
        untrackedFiles: 0,
        includedAdded: 0,
        includedRemoved: 0,
        pendingAdded: 1,
        pendingRemoved: 1,
      },
    } as any;
  }

  it('does not schedule background polling timers on getSync', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    getStateMock.mockReturnValue({
      sessions: {
        s1: { id: 's1', metadata: { machineId: 'machine-a', path: '/repo' } },
      },
      applyScmStatus: applyScmStatusMock,
      updateSessionProjectScmSnapshot: updateSnapshotMock,
      updateSessionProjectScmSnapshotError: updateSnapshotErrorMock,
      getSessionProjectScmSnapshotError: getSnapshotErrorMock,
      pruneSessionProjectScmTouchedPaths: pruneTouchedPathsMock,
      pruneSessionProjectScmCommitSelectionPaths: pruneCommitSelectionPathsMock,
      pruneSessionProjectScmCommitSelectionPatches: pruneCommitSelectionPatchesMock,
    });

    const { ScmStatusSync } = await import('./scmStatusSync');

    const syncer = new ScmStatusSync();
    syncer.getSync('s1');
    expect(setTimeoutSpy).not.toHaveBeenCalled();

    setTimeoutSpy.mockRestore();
  });

  it('deduplicates snapshot publishing when signature has not changed', async () => {
    getStateMock.mockReturnValue({
      sessions: {
        s1: { id: 's1', metadata: { machineId: 'machine-a', path: '/repo' } },
      },
      applyScmStatus: applyScmStatusMock,
      updateSessionProjectScmSnapshot: updateSnapshotMock,
      updateSessionProjectScmSnapshotError: updateSnapshotErrorMock,
      getSessionProjectScmSnapshotError: getSnapshotErrorMock,
      pruneSessionProjectScmTouchedPaths: pruneTouchedPathsMock,
      pruneSessionProjectScmCommitSelectionPaths: pruneCommitSelectionPathsMock,
      pruneSessionProjectScmCommitSelectionPatches: pruneCommitSelectionPatchesMock,
    });

    fetchSnapshotForSessionMock
      .mockResolvedValueOnce(buildRepoSnapshot({ fetchedAt: 100 }))
      .mockResolvedValueOnce(buildRepoSnapshot({ fetchedAt: 200 }));

    const { ScmStatusSync } = await import('./scmStatusSync');

    const syncer = new ScmStatusSync();
    const sync = syncer.getSync('s1');

    await sync.invalidateAndAwait();
    await sync.invalidateAndAwait();

    // First fetch publishes snapshot; second fetch is signature-identical (only fetchedAt differs) so it should not re-publish.
    expect(updateSnapshotMock).toHaveBeenCalledTimes(1);
    expect(applyScmStatusMock).toHaveBeenCalledTimes(1);
  });

  it('publishes snapshot updates when signature changes', async () => {
    getStateMock.mockReturnValue({
      sessions: {
        s1: { id: 's1', metadata: { machineId: 'machine-a', path: '/repo' } },
      },
      applyScmStatus: applyScmStatusMock,
      updateSessionProjectScmSnapshot: updateSnapshotMock,
      updateSessionProjectScmSnapshotError: updateSnapshotErrorMock,
      getSessionProjectScmSnapshotError: getSnapshotErrorMock,
      pruneSessionProjectScmTouchedPaths: pruneTouchedPathsMock,
      pruneSessionProjectScmCommitSelectionPaths: pruneCommitSelectionPathsMock,
      pruneSessionProjectScmCommitSelectionPatches: pruneCommitSelectionPatchesMock,
    });

    fetchSnapshotForSessionMock
      .mockResolvedValueOnce(buildRepoSnapshot({ fetchedAt: 100, head: 'main' }))
      .mockResolvedValueOnce(buildRepoSnapshot({ fetchedAt: 200, head: 'feature' }));

    const { ScmStatusSync } = await import('./scmStatusSync');

    const syncer = new ScmStatusSync();
    const sync = syncer.getSync('s1');

    await sync.invalidateAndAwait();
    await sync.invalidateAndAwait();

    expect(updateSnapshotMock).toHaveBeenCalledTimes(2);
  });

  it('suspends auto-refresh after feature unsupported until a user refresh occurs', async () => {
    getStateMock.mockReturnValue({
      sessions: {
        s1: { id: 's1', metadata: { machineId: 'machine-a', path: '/repo' } },
      },
      applyScmStatus: applyScmStatusMock,
      updateSessionProjectScmSnapshot: updateSnapshotMock,
      updateSessionProjectScmSnapshotError: updateSnapshotErrorMock,
      getSessionProjectScmSnapshotError: getSnapshotErrorMock,
      pruneSessionProjectScmTouchedPaths: pruneTouchedPathsMock,
      pruneSessionProjectScmCommitSelectionPaths: pruneCommitSelectionPathsMock,
      pruneSessionProjectScmCommitSelectionPatches: pruneCommitSelectionPatchesMock,
    });

    const err = Object.assign(new Error('RPC method not available'), {
      scmErrorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
    });
    fetchSnapshotForSessionMock.mockRejectedValueOnce(err).mockResolvedValueOnce(buildRepoSnapshot({ fetchedAt: 123 }));

    const { ScmStatusSync } = await import('./scmStatusSync');

    const syncer = new ScmStatusSync();

    // Auto refresh hits unsupported and suspends further auto refreshes.
    syncer.invalidateFromAutoRefresh('s1');
    await syncer.getSync('s1').invalidateAndAwait();

    syncer.invalidateFromAutoRefresh('s1');
    await syncer.getSync('s1').awaitQueue();
    expect(fetchSnapshotForSessionMock).toHaveBeenCalledTimes(1);

    // User refresh clears the suspension and retries.
    await syncer.invalidateFromUserAndAwait('s1');
    expect(fetchSnapshotForSessionMock).toHaveBeenCalledTimes(2);

    const lastCall = updateSnapshotErrorMock.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe('s1');
    expect(lastCall?.[1]).toMatchObject({
      message: 'RPC method not available',
      errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
    });
  });
});
