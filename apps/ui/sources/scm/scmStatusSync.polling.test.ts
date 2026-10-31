import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

const getStateMock = vi.hoisted(() => vi.fn());
// The sync publishes through the batched store action; forward it to the per-action
// spies so tests keep asserting the observable publish behavior per session.
// The prune gate mirrors the store's canonical behavior: touched-path and
// commit-selection pruning runs ONLY when the snapshot carries the complete
// entry set — a summary's `entries: []` is evidence of absence, not absence
// of evidence.
const withBatchedScmPublish = vi.hoisted(() => (state: any) => {
    if (!state || state.publishSessionProjectScmSnapshots) return state;
    state.publishSessionProjectScmSnapshots = (publishes: ReadonlyArray<{ sessionId: string; snapshot: any; status: unknown }>) => {
        for (const { sessionId, snapshot, status } of publishes) {
            state.updateSessionProjectScmSnapshot(sessionId, snapshot);
            if (state.getSessionProjectScmSnapshotError(sessionId)) {
                state.updateSessionProjectScmSnapshotError(sessionId, null);
            }
            state.applyScmStatus(sessionId, status);
            const presentation = snapshot.entriesPresentation;
            const entriesAreComplete = presentation === undefined || presentation === 'complete';
            if (entriesAreComplete) {
                const activePaths = new Set((snapshot.entries ?? []).map((entry: any) => entry.path));
                state.pruneSessionProjectScmTouchedPaths(sessionId, activePaths);
                state.pruneSessionProjectScmCommitSelectionPaths(sessionId, activePaths);
                state.pruneSessionProjectScmCommitSelectionPatches(sessionId, activePaths);
            }
        }
    };
    return state;
});
const applyScmStatusMock = vi.hoisted(() => vi.fn());
const updateSnapshotMock = vi.hoisted(() => vi.fn());
const updateSnapshotErrorMock = vi.hoisted(() => vi.fn());
const pruneCommitSelectionPathsMock = vi.hoisted(() => vi.fn());
const pruneTouchedPathsMock = vi.hoisted(() => vi.fn());
const pruneCommitSelectionPatchesMock = vi.hoisted(() => vi.fn());
const markTouchedPathsMock = vi.hoisted(() => vi.fn());
const getSnapshotErrorMock = vi.hoisted(() => vi.fn(() => null));
const clearSearchCacheForProjectMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    AppState: {
                        currentState: 'active',
                        addEventListener: vi.fn(() => ({ remove: vi.fn() })),
                    },
                }
    );
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    storage: {
    getState: () => withBatchedScmPublish(getStateMock()),
  },
});
});

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
    markTouchedPathsMock.mockReset();
    fetchSnapshotForSessionMock.mockReset();
    getSnapshotErrorMock.mockReset();
    clearSearchCacheForProjectMock.mockClear();
  });

  function buildRepoSnapshot(params: { fetchedAt: number; head?: string; pendingFiles?: number }) {
    return buildSummaryShapeSnapshot({ fetchedAt: params.fetchedAt, head: params.head, pendingFiles: params.pendingFiles });
  }

  /** Legacy complete-entry snapshot (pre-split shape) used to seed the entries-carrying pin. */
  function buildEntriesCarryingSnapshot(params: { fetchedAt: number; pendingFiles?: number }) {
    const snapshot = buildSummaryShapeSnapshot({ fetchedAt: params.fetchedAt, pendingFiles: params.pendingFiles });
    snapshot.entriesPresentation = 'complete';
    snapshot.entries = [
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
    ];
    return snapshot;
  }

  /** New-daemon summary snapshot: totals carry the truth, entries are omitted. */
  function buildSummaryShapeSnapshot(params: { fetchedAt: number; head?: string; pendingFiles?: number }) {
    const pendingFiles = params.pendingFiles ?? 1;
    return {
      projectKey: 'machine-a:/repo',
      fetchedAt: params.fetchedAt,
      repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
      capabilities: { readStatus: true },
      branch: { head: params.head ?? 'main', upstream: null, ahead: 0, behind: 0, detached: false },
      stashCount: 0,
      hasConflicts: false,
      entries: [],
      totals: {
        includedFiles: 0,
        pendingFiles,
        untrackedFiles: 0,
        includedAdded: 0,
        includedRemoved: 0,
        pendingAdded: 1,
        pendingRemoved: 1,
        changedFiles: pendingFiles,
      },
      entriesPresentation: 'omitted',
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

  it('hydrates a newly scoped session when the repository signature has not changed', async () => {
    const firstSnapshot = buildRepoSnapshot({ fetchedAt: 100 });
    const secondSnapshot = buildRepoSnapshot({ fetchedAt: 200 });
    let hydratedSessionIds = new Set<string>();
    let sessions: Record<string, any> = {
      s1: { id: 's1', metadata: { machineId: 'machine-a', path: '/repo' } },
    };

    getStateMock.mockImplementation(() => ({
      sessions,
      applyScmStatus: applyScmStatusMock,
      updateSessionProjectScmSnapshot: (sessionId: string, snapshot: unknown) => {
        hydratedSessionIds.add(sessionId);
        updateSnapshotMock(sessionId, snapshot);
      },
      updateSessionProjectScmSnapshotError: updateSnapshotErrorMock,
      getSessionProjectScmSnapshotError: getSnapshotErrorMock,
      getSessionProjectScmSnapshot: (sessionId: string) => (hydratedSessionIds.has(sessionId) ? firstSnapshot : null),
      pruneSessionProjectScmTouchedPaths: pruneTouchedPathsMock,
      pruneSessionProjectScmCommitSelectionPaths: pruneCommitSelectionPathsMock,
      pruneSessionProjectScmCommitSelectionPatches: pruneCommitSelectionPatchesMock,
    }));

    fetchSnapshotForSessionMock
      .mockResolvedValueOnce(firstSnapshot)
      .mockResolvedValueOnce(secondSnapshot);

    const { ScmStatusSync } = await import('./scmStatusSync');

    const syncer = new ScmStatusSync();
    await syncer.getSync('s1').invalidateAndAwait();

    expect(updateSnapshotMock).toHaveBeenCalledTimes(1);
    expect(updateSnapshotMock).toHaveBeenCalledWith('s1', firstSnapshot);

    updateSnapshotMock.mockClear();
    applyScmStatusMock.mockClear();
    sessions = {
      ...sessions,
      s2: { id: 's2', metadata: { machineId: 'machine-a', path: '/repo/packages/app' } },
    };

    const s2Sync = syncer.getSync('s2');
    hydratedSessionIds.delete('s2');
    updateSnapshotMock.mockClear();
    applyScmStatusMock.mockClear();

    await s2Sync.invalidateAndAwait();

    expect(updateSnapshotMock).toHaveBeenCalledWith('s2', secondSnapshot);
    expect(updateSnapshotMock).not.toHaveBeenCalledWith('s1', secondSnapshot);
    expect(applyScmStatusMock).toHaveBeenCalledTimes(1);
  });

  it('hydrates a session from the cached project snapshot when it joins an already fetched repository', async () => {
    const firstSnapshot = buildRepoSnapshot({ fetchedAt: 100 });
    const hydratedSnapshots = new Map<string, unknown>();
    let sessions: Record<string, any> = {
      s1: { id: 's1', metadata: { machineId: 'machine-a', path: '/repo' } },
    };

    getStateMock.mockImplementation(() => ({
      sessions,
      applyScmStatus: applyScmStatusMock,
      updateSessionProjectScmSnapshot: (sessionId: string, snapshot: unknown) => {
        hydratedSnapshots.set(sessionId, snapshot);
        updateSnapshotMock(sessionId, snapshot);
      },
      updateSessionProjectScmSnapshotError: updateSnapshotErrorMock,
      getSessionProjectScmSnapshotError: getSnapshotErrorMock,
      getSessionProjectScmSnapshot: (sessionId: string) => hydratedSnapshots.get(sessionId) ?? null,
      pruneSessionProjectScmTouchedPaths: pruneTouchedPathsMock,
      pruneSessionProjectScmCommitSelectionPaths: pruneCommitSelectionPathsMock,
      pruneSessionProjectScmCommitSelectionPatches: pruneCommitSelectionPatchesMock,
    }));

    fetchSnapshotForSessionMock.mockResolvedValueOnce(firstSnapshot);

    const { ScmStatusSync } = await import('./scmStatusSync');

    const syncer = new ScmStatusSync();
    await syncer.getSync('s1').invalidateAndAwait();

    updateSnapshotMock.mockClear();
    applyScmStatusMock.mockClear();
    sessions = {
      ...sessions,
      s2: { id: 's2', metadata: { machineId: 'machine-a', path: '/repo/packages/app' } },
    };

    syncer.getSync('s2');

    expect(fetchSnapshotForSessionMock).toHaveBeenCalledTimes(1);
    expect(updateSnapshotMock).toHaveBeenCalledWith('s2', firstSnapshot);
    expect(applyScmStatusMock).toHaveBeenCalledTimes(1);
  });

  it('continues refreshing after moving a session-path sync to the repository root key', async () => {
    getStateMock.mockReturnValue({
      sessions: {
        s1: { id: 's1', metadata: { machineId: 'machine-a', path: '/repo/packages/app' } },
      },
      applyScmStatus: applyScmStatusMock,
      updateSessionProjectScmSnapshot: updateSnapshotMock,
      updateSessionProjectScmSnapshotError: updateSnapshotErrorMock,
      getSessionProjectScmSnapshot: () => buildRepoSnapshot({ fetchedAt: 100 }),
      getSessionProjectScmSnapshotError: getSnapshotErrorMock,
      pruneSessionProjectScmTouchedPaths: pruneTouchedPathsMock,
      pruneSessionProjectScmCommitSelectionPaths: pruneCommitSelectionPathsMock,
      pruneSessionProjectScmCommitSelectionPatches: pruneCommitSelectionPatchesMock,
    });

    const firstSnapshot = buildRepoSnapshot({ fetchedAt: 100 });
    const secondSnapshot = buildRepoSnapshot({ fetchedAt: 200, head: 'feature/refreshed' });
    fetchSnapshotForSessionMock
      .mockResolvedValueOnce(firstSnapshot)
      .mockResolvedValueOnce(secondSnapshot);

    const { ScmStatusSync } = await import('./scmStatusSync');

    const syncer = new ScmStatusSync();
    await syncer.getSync('s1').invalidateAndAwait();
    updateSnapshotMock.mockClear();

    await syncer.getSync('s1').invalidateAndAwait();

    expect(fetchSnapshotForSessionMock).toHaveBeenCalledTimes(2);
    expect(updateSnapshotMock).toHaveBeenCalledWith('s1', secondSnapshot);
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

  it('publishes visible pull request metadata updates when files and branch are unchanged', async () => {
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
      .mockResolvedValueOnce(buildRepoSnapshot({ fetchedAt: 100, head: 'feature/pr' }))
      .mockResolvedValueOnce({
        ...buildRepoSnapshot({ fetchedAt: 200, head: 'feature/pr' }),
        hostingProvider: {
          kind: 'github',
          name: 'GitHub',
          baseUrl: 'https://github.com',
          nameWithOwner: 'happier/dev',
          remoteName: 'origin',
        },
        pullRequest: {
          provider: {
            kind: 'github',
            name: 'GitHub',
            baseUrl: 'https://github.com',
            nameWithOwner: 'happier/dev',
            remoteName: 'origin',
          },
          number: 42,
          title: 'Add PR workflow',
          url: 'https://github.com/happier/dev/pull/42',
          baseBranch: 'main',
          headBranch: 'feature/pr',
          state: 'open',
        },
      });

    const { ScmStatusSync } = await import('./scmStatusSync');

    const syncer = new ScmStatusSync();
    const sync = syncer.getSync('s1');

    await sync.invalidateAndAwait();
    await sync.invalidateAndAwait();

    expect(updateSnapshotMock).toHaveBeenCalledTimes(2);
  });

  it('triggers a fetch when invalidated from auto-refresh before getSync is called', async () => {
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

    fetchSnapshotForSessionMock.mockResolvedValueOnce(buildRepoSnapshot({ fetchedAt: 100 }));

    const { ScmStatusSync } = await import('./scmStatusSync');

    const syncer = new ScmStatusSync();
    syncer.invalidateFromAutoRefresh('s1');

    await syncer.getSync('s1').awaitQueue({ timeoutMs: 1000 });
    expect(fetchSnapshotForSessionMock).toHaveBeenCalledTimes(1);
  });

  it('rate limits automatic refreshes per project without blocking user refreshes', async () => {
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
    syncer.invalidateFromAutoRefresh('s1');
    await syncer.getSync('s1').awaitQueue({ timeoutMs: 1000 });
    expect(fetchSnapshotForSessionMock).toHaveBeenCalledTimes(1);

    syncer.invalidateFromAutoRefresh('s1');
    await syncer.getSync('s1').awaitQueue({ timeoutMs: 50 });
    expect(fetchSnapshotForSessionMock).toHaveBeenCalledTimes(1);

    await syncer.invalidateFromUserAndAwait('s1');
    expect(fetchSnapshotForSessionMock).toHaveBeenCalledTimes(2);
  });

  it('uses project key path to trigger fetch when session metadata path is missing', async () => {
    getStateMock.mockReturnValue({
      sessions: {
        s1: { id: 's1', metadata: { machineId: 'machine-a', path: null } },
      },
      getProjectForSession: (sessionId: string) =>
        sessionId === 's1'
          ? {
              key: {
                machineId: 'machine-a',
                path: '/repo-from-project',
              },
            }
          : null,
      applyScmStatus: applyScmStatusMock,
      updateSessionProjectScmSnapshot: updateSnapshotMock,
      updateSessionProjectScmSnapshotError: updateSnapshotErrorMock,
      getSessionProjectScmSnapshotError: getSnapshotErrorMock,
      pruneSessionProjectScmTouchedPaths: pruneTouchedPathsMock,
      pruneSessionProjectScmCommitSelectionPaths: pruneCommitSelectionPathsMock,
      pruneSessionProjectScmCommitSelectionPatches: pruneCommitSelectionPatchesMock,
    });

    fetchSnapshotForSessionMock.mockResolvedValueOnce(buildRepoSnapshot({ fetchedAt: 100 }));

    const { ScmStatusSync } = await import('./scmStatusSync');

    const syncer = new ScmStatusSync();
    syncer.invalidateFromAutoRefresh('s1');

    await syncer.getSync('s1').awaitQueue({ timeoutMs: 1000 });
    expect(fetchSnapshotForSessionMock).toHaveBeenCalledTimes(1);
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
    await syncer.getSync('s1').awaitQueue({ timeoutMs: 1000 });

    syncer.invalidateFromAutoRefresh('s1');
    await syncer.getSync('s1').awaitQueue({ timeoutMs: 50 });
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

  it('does not bypass auto-refresh suspension when invalidated from mutations', async () => {
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

    // Auto refresh hits unsupported and suspends further automatic refresh attempts.
    syncer.invalidateFromAutoRefresh('s1');
    await syncer.getSync('s1').awaitQueue({ timeoutMs: 1000 });

    // Mutation invalidation should not bypass the suspension.
    syncer.invalidateFromMutation('s1');
    await syncer.getSync('s1').awaitQueue({ timeoutMs: 50 });
    expect(fetchSnapshotForSessionMock).toHaveBeenCalledTimes(1);

    // User refresh clears the suspension and retries.
    await syncer.invalidateFromUserAndAwait('s1');
    expect(fetchSnapshotForSessionMock).toHaveBeenCalledTimes(2);
  });

  it('publishes summary snapshots and skips pruning while entries are omitted', async () => {
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
      markSessionProjectScmTouchedPaths: markTouchedPathsMock,
    });

    fetchSnapshotForSessionMock.mockResolvedValueOnce(buildRepoSnapshot({ fetchedAt: 100 }));

    const { ScmStatusSync } = await import('./scmStatusSync');

    const syncer = new ScmStatusSync();
    await syncer.getSync('s1').invalidateAndAwait();

    expect(updateSnapshotMock).toHaveBeenCalledTimes(1);
    const published = updateSnapshotMock.mock.calls[0]?.[1];
    expect(published?.entriesPresentation).toBe('omitted');
    expect(published?.entries).toEqual([]);
    // A summary's empty entries array must never reach the prune path.
    expect(pruneTouchedPathsMock).not.toHaveBeenCalled();
    expect(pruneCommitSelectionPathsMock).not.toHaveBeenCalled();
    expect(pruneCommitSelectionPatchesMock).not.toHaveBeenCalled();
  });

  it('keeps the entries-carrying pin so summary polls with unchanged totals never refetch for attribution', async () => {
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
      markSessionProjectScmTouchedPaths: markTouchedPathsMock,
    });

    fetchSnapshotForSessionMock
      .mockResolvedValueOnce(buildEntriesCarryingSnapshot({ fetchedAt: 100 }))
      .mockResolvedValueOnce(buildRepoSnapshot({ fetchedAt: 200 }));

    const { ScmStatusSync } = await import('./scmStatusSync');

    const syncer = new ScmStatusSync();
    await syncer.getSync('s1').invalidateAndAwait();

    await syncer.invalidateFromMutationAndAwait('s1');

    // Poll 1 (entries-carrying) + poll 2 (summary) only. A summary snapshot
    // must not overwrite the entries-carrying pin — otherwise its totals would
    // look like a delta and trigger a spurious attribution refetch.
    expect(fetchSnapshotForSessionMock).toHaveBeenCalledTimes(2);
    expect(fetchSnapshotForSessionMock).toHaveBeenNthCalledWith(1, 's1');
    expect(fetchSnapshotForSessionMock).toHaveBeenNthCalledWith(2, 's1');
    expect(markTouchedPathsMock).not.toHaveBeenCalled();
  });

  it('performs exactly one entries-carrying refetch when totals change inside a mutation window', async () => {
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
      markSessionProjectScmTouchedPaths: markTouchedPathsMock,
    });

    const refetched = buildEntriesCarryingSnapshot({ fetchedAt: 300, pendingFiles: 2 });
    refetched.entries = [
      {
        ...refetched.entries[0],
        stats: {
          ...refetched.entries[0].stats,
          pendingAdded: 5,
          pendingRemoved: 2,
        },
      },
      {
        path: 'src/b.ts',
        previousPath: null,
        kind: 'added',
        includeStatus: 'A',
        pendingStatus: ' ',
        hasIncludedDelta: true,
        hasPendingDelta: false,
        stats: {
          includedAdded: 3,
          includedRemoved: 0,
          pendingAdded: 0,
          pendingRemoved: 0,
          isBinary: false,
        },
      },
    ];

    fetchSnapshotForSessionMock
      .mockResolvedValueOnce(buildEntriesCarryingSnapshot({ fetchedAt: 100 }))
      // Summary poll inside a mutation window with UNCHANGED totals: no refetch.
      .mockResolvedValueOnce(buildRepoSnapshot({ fetchedAt: 200 }))
      // Summary poll inside a fresh mutation window with a totals DELTA.
      .mockResolvedValueOnce(buildRepoSnapshot({ fetchedAt: 300, pendingFiles: 2 }))
      // The one entries-carrying attribution refetch.
      .mockResolvedValueOnce(refetched);

    const { ScmStatusSync } = await import('./scmStatusSync');

    const syncer = new ScmStatusSync();
    await syncer.getSync('s1').invalidateAndAwait();
    await syncer.invalidateFromMutationAndAwait('s1');
    expect(fetchSnapshotForSessionMock).toHaveBeenCalledTimes(2);
    expect(markTouchedPathsMock).not.toHaveBeenCalled();

    await syncer.invalidateFromMutationAndAwait('s1');

    expect(fetchSnapshotForSessionMock).toHaveBeenCalledTimes(4);
    expect(fetchSnapshotForSessionMock).toHaveBeenNthCalledWith(3, 's1');
    expect(fetchSnapshotForSessionMock).toHaveBeenNthCalledWith(4, 's1', {
      includeEntries: true,
      untrackedFiles: 'normal',
    });
    // The marked paths come from the pinned-vs-refetched entry diff — never
    // from the summary's omitted entries (which would fabricate removals).
    expect(markTouchedPathsMock).toHaveBeenCalledTimes(1);
    expect(markTouchedPathsMock.mock.calls[0]?.[0]).toBe('s1');
    expect([...markTouchedPathsMock.mock.calls[0]?.[1]].sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });
});
