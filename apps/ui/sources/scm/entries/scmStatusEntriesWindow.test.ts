import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SCM_OPERATION_ERROR_CODES, type ScmStatusEntriesResponse } from '@happier-dev/protocol';

import type { ScmWorkingEntry, ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

const fetchSnapshotForSessionMock = vi.hoisted(() => vi.fn());
const machineScmStatusEntriesMock = vi.hoisted(() => vi.fn());
const resolveRepoScmSessionRequestMock = vi.hoisted(() => vi.fn());

vi.mock('@/scm/scmRepositoryService', () => ({
    scmRepositoryService: {
        fetchSnapshotForSession: fetchSnapshotForSessionMock,
    },
}));

vi.mock('@/sync/ops/scm/machineScm', () => ({
    machineScmStatusEntries: machineScmStatusEntriesMock,
}));

vi.mock('@/scm/repository/resolveRepoScmSessionRequest', () => ({
    resolveRepoScmSessionRequest: resolveRepoScmSessionRequestMock,
}));

import { ScmStatusEntriesWindow } from './scmStatusEntriesWindow';

function makeEntry(path: string, overrides?: Partial<ScmWorkingEntry>): ScmWorkingEntry {
    return {
        path,
        previousPath: null,
        kind: 'untracked',
        includeStatus: '?',
        pendingStatus: '?',
        hasIncludedDelta: false,
        hasPendingDelta: true,
        stats: {
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 0,
            pendingRemoved: 0,
            isBinary: false,
        },
        ...overrides,
    };
}

function makeCollapsedSnapshot(input?: {
    fetchedAt?: number;
    entries?: ScmWorkingEntry[];
    entriesPresentation?: 'complete' | 'truncated' | 'omitted';
}): ScmWorkingSnapshot {
    return {
        projectKey: 'machine-a:/repo',
        fetchedAt: input?.fetchedAt ?? 100,
        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
        hasConflicts: false,
        entries: input?.entries ?? [makeEntry('D/', { isDirectory: true, untrackedFileCount: 30000 })],
        entriesPresentation: input?.entriesPresentation ?? 'complete',
        totals: {
            includedFiles: 0,
            pendingFiles: 0,
            untrackedFiles: 30000,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 0,
            pendingRemoved: 0,
            changedFiles: 30000,
        },
    } as ScmWorkingSnapshot;
}

function makeEntriesPage(paths: string[], hasMore: boolean, fetchedAt = 1): ScmStatusEntriesResponse {
    return {
        success: true,
        entries: paths.map((path) => makeEntry(path)),
        hasMore,
        ...(hasMore ? { nextCursor: paths[paths.length - 1] } : {}),
        fetchedAt,
    };
}

beforeEach(() => {
    fetchSnapshotForSessionMock.mockReset();
    machineScmStatusEntriesMock.mockReset();
    resolveRepoScmSessionRequestMock.mockReset();
    resolveRepoScmSessionRequestMock.mockReturnValue({
        sessionId: 's1',
        machineId: 'machine-a',
        resolvedPath: '/repo',
        repoIdentityKey: 'machine-a:/repo',
    });
});

describe('ScmStatusEntriesWindow', () => {
    it('continues a truncated top-level window through the paged entries route', async () => {
        fetchSnapshotForSessionMock.mockResolvedValueOnce(makeCollapsedSnapshot({
            entriesPresentation: 'truncated',
            entries: [
                makeEntry('D/', { isDirectory: true, untrackedFileCount: 30000 }),
                makeEntry('a-first.ts'),
            ],
        }));
        machineScmStatusEntriesMock.mockResolvedValueOnce(makeEntriesPage(['z-last.ts'], false));

        const window = new ScmStatusEntriesWindow({ sessionId: 's1' });
        await window.refresh();
        expect(window.getState().truncated).toBe(true);
        expect(window.getState().entries.map((entry) => entry.path)).toEqual(['D/', 'a-first.ts']);

        await window.loadMoreTopLevel();

        expect(machineScmStatusEntriesMock).toHaveBeenCalledWith('machine-a', {
            cwd: '/repo',
            afterPath: 'a-first.ts',
            untrackedFiles: 'normal',
        });
        expect(window.getState().truncated).toBe(false);
        expect(window.getState().entries.map((entry) => entry.path)).toEqual(['D/', 'a-first.ts', 'z-last.ts']);
    });

    it('does not invalidate a pending expansion when top-level continuation runs (separate request generation)', async () => {
        fetchSnapshotForSessionMock.mockResolvedValue(makeCollapsedSnapshot({
            entriesPresentation: 'truncated',
            entries: [
                makeEntry('D/', { isDirectory: true, untrackedFileCount: 30000 }),
                makeEntry('a-first.ts'),
            ],
        }));
        let resolveExpansion!: (value: ScmStatusEntriesResponse) => void;
        let resolveTopLevel!: (value: ScmStatusEntriesResponse) => void;
        machineScmStatusEntriesMock
            .mockReturnValueOnce(new Promise((resolve) => { resolveExpansion = resolve; }))
            .mockReturnValueOnce(new Promise((resolve) => { resolveTopLevel = resolve; }));

        const window = new ScmStatusEntriesWindow({ sessionId: 's1' });
        await window.refresh();
        const expandPromise = window.expandDirectory('D/');
        const loadMorePromise = window.loadMoreTopLevel();

        // The top-level continuation started while the expansion is in flight; the
        // expansion reply must still be accepted.
        resolveExpansion(makeEntriesPage(['D/a.ts'], false) as ScmStatusEntriesResponse);
        await expandPromise;
        expect(window.getState().expansions.get('D/')?.entries.map((entry) => entry.path)).toEqual(['D/a.ts']);

        resolveTopLevel(makeEntriesPage(['z-last.ts'], false) as ScmStatusEntriesResponse);
        await loadMorePromise;
        expect(window.getState().entries.map((entry) => entry.path)).toEqual(['D/', 'a-first.ts', 'z-last.ts']);
    });

    it('filters descendants under collapsed directory rows from a mixed-version continuation reply', async () => {
        fetchSnapshotForSessionMock.mockResolvedValueOnce(makeCollapsedSnapshot({
            entriesPresentation: 'truncated',
            entries: [
                makeEntry('D/', { isDirectory: true, untrackedFileCount: 30000 }),
                makeEntry('a-first.ts'),
            ],
        }));
        // Pre-untrackedFiles daemon: pages the per-file 'all' shape — rows under D/ are
        // structural descendants of the already-collapsed row, not top-level rows.
        machineScmStatusEntriesMock.mockResolvedValueOnce(makeEntriesPage(['D/a.ts', 'z-last.ts'], false));

        const window = new ScmStatusEntriesWindow({ sessionId: 's1' });
        await window.refresh();
        await window.loadMoreTopLevel();

        expect(window.getState().entries.map((entry) => entry.path)).toEqual(['D/', 'a-first.ts', 'z-last.ts']);
    });

    it('restores a retryable ready state when the fallback fetch rejects during top-level continuation', async () => {
        fetchSnapshotForSessionMock.mockResolvedValueOnce(makeCollapsedSnapshot({
            entriesPresentation: 'truncated',
            entries: [makeEntry('D/', { isDirectory: true, untrackedFileCount: 30000 }), makeEntry('a-first.ts')],
        }));
        machineScmStatusEntriesMock.mockResolvedValueOnce({
            success: false,
            entries: [],
            hasMore: false,
            fetchedAt: 1,
            errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
        });
        fetchSnapshotForSessionMock.mockRejectedValueOnce(new Error('rpc down'));

        const window = new ScmStatusEntriesWindow({ sessionId: 's1' });
        await window.refresh();
        await window.loadMoreTopLevel();

        expect(window.getState().status).toBe('ready');
        expect(window.getState().error).toBe('rpc down');
    });

    it('drops an in-flight expansion reply that lands after the directory was collapsed', async () => {
        fetchSnapshotForSessionMock.mockResolvedValue(makeCollapsedSnapshot());
        let resolveExpand!: (value: ScmStatusEntriesResponse) => void;
        machineScmStatusEntriesMock.mockReturnValueOnce(new Promise((resolve) => {
            resolveExpand = resolve;
        }));

        const window = new ScmStatusEntriesWindow({ sessionId: 's1' });
        await window.refresh();
        const expandPromise = window.expandDirectory('D/');
        expect(window.getState().expansions.get('D/')?.loading).toBe(true);

        window.collapseDirectory('D/');
        expect(window.getState().expansions.has('D/')).toBe(false);

        resolveExpand(makeEntriesPage(['D/late.ts'], false) as ScmStatusEntriesResponse);
        await expandPromise;

        // The late reply must not resurrect the collapsed expansion.
        expect(window.getState().expansions.has('D/')).toBe(false);
    });

    it('loads collapsed rows on refresh via one entries-carrying normal-mode snapshot fetch', async () => {
        fetchSnapshotForSessionMock.mockResolvedValueOnce(makeCollapsedSnapshot());

        const window = new ScmStatusEntriesWindow({ sessionId: 's1' });
        await window.refresh();

        expect(fetchSnapshotForSessionMock).toHaveBeenCalledWith('s1', {
            includeEntries: true,
            untrackedFiles: 'normal',
        });
        expect(machineScmStatusEntriesMock).not.toHaveBeenCalled();
        const state = window.getState();
        expect(state.mode).toBe('window');
        expect(state.status).toBe('ready');
        expect(state.entries).toHaveLength(1);
        expect(state.entries[0]?.isDirectory).toBe(true);
        expect(state.fallbackEntries).toBeNull();
    });

    it('keeps last-known rows visible while refreshing (continuity, no loading flash)', async () => {
        fetchSnapshotForSessionMock.mockResolvedValueOnce(makeCollapsedSnapshot({ fetchedAt: 100 }));

        const window = new ScmStatusEntriesWindow({ sessionId: 's1' });
        await window.refresh();

        let secondResolve!: (value: unknown) => void;
        fetchSnapshotForSessionMock.mockReturnValueOnce(new Promise((resolve) => {
            secondResolve = resolve;
        }));
        const refreshPromise = window.refresh();
        expect(window.getState().status).toBe('loading');
        expect(window.getState().entries).toHaveLength(1);

        secondResolve(makeCollapsedSnapshot({ fetchedAt: 200 }));
        await refreshPromise;
        expect(window.getState().status).toBe('ready');
    });

    it('pages a directory expansion via scm.status.entries expandPath with load-more', async () => {
        fetchSnapshotForSessionMock.mockResolvedValue(makeCollapsedSnapshot());
        machineScmStatusEntriesMock
            .mockResolvedValueOnce(makeEntriesPage(['D/a.ts', 'D/b.ts'], true))
            .mockResolvedValueOnce(makeEntriesPage(['D/c.ts'], false));

        const window = new ScmStatusEntriesWindow({ sessionId: 's1' });
        await window.refresh();
        await window.expandDirectory('D/');

        expect(machineScmStatusEntriesMock).toHaveBeenNthCalledWith(1, 'machine-a', {
            cwd: '/repo',
            expandPath: 'D/',
        });
        let expansion = window.getState().expansions.get('D/');
        expect(expansion?.entries.map((entry) => entry.path)).toEqual(['D/a.ts', 'D/b.ts']);
        expect(expansion?.hasMore).toBe(true);
        expect(expansion?.loading).toBe(false);

        await window.loadMoreExpanded('D/');
        expansion = window.getState().expansions.get('D/');
        expect(machineScmStatusEntriesMock).toHaveBeenNthCalledWith(2, 'machine-a', {
            cwd: '/repo',
            expandPath: 'D/',
            afterPath: 'D/b.ts',
        });
        expect(expansion?.entries.map((entry) => entry.path)).toEqual(['D/a.ts', 'D/b.ts', 'D/c.ts']);
        expect(expansion?.hasMore).toBe(false);

        window.collapseDirectory('D/');
        expect(window.getState().expansions.has('D/')).toBe(false);
    });

    it('falls back to an entries-carrying snapshot when the entries RPC is unsupported (T5)', async () => {
        fetchSnapshotForSessionMock
            .mockResolvedValueOnce(makeCollapsedSnapshot())
            // T5 fallback refetch: today's per-file UX.
            .mockResolvedValueOnce(makeCollapsedSnapshot({
                entries: [makeEntry('D/a.ts'), makeEntry('D/b.ts')],
                entriesPresentation: 'complete',
            }));
        machineScmStatusEntriesMock.mockResolvedValue({
            success: false,
            entries: [],
            hasMore: false,
            fetchedAt: 1,
            error: 'RPC method not available',
            errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
        });

        const window = new ScmStatusEntriesWindow({ sessionId: 's1' });
        await window.refresh();
        await window.expandDirectory('D/');

        expect(fetchSnapshotForSessionMock).toHaveBeenNthCalledWith(2, 's1', {
            includeEntries: true,
            untrackedFiles: 'all',
        });
        const state = window.getState();
        expect(state.mode).toBe('snapshot-fallback');
        expect(state.status).toBe('ready');
        expect(state.fallbackEntries?.map((entry) => entry.path)).toEqual(['D/a.ts', 'D/b.ts']);
        expect(state.expansions.size).toBe(0);
    });

    it('renders a truncated collapsed prefix and keeps expansions working (honest incompleteness)', async () => {
        fetchSnapshotForSessionMock.mockResolvedValue(makeCollapsedSnapshot({
            entries: [makeEntry('D/', { isDirectory: true, untrackedFileCount: 30000 })],
            entriesPresentation: 'truncated',
        }));
        machineScmStatusEntriesMock.mockResolvedValue(makeEntriesPage(['D/a.ts'], false));

        const window = new ScmStatusEntriesWindow({ sessionId: 's1' });
        await window.refresh();

        const state = window.getState();
        expect(state.mode).toBe('window');
        expect(state.status).toBe('ready');
        expect(state.truncated).toBe(true);
        expect(state.entries).toHaveLength(1);

        await window.expandDirectory('D/');
        expect(machineScmStatusEntriesMock).toHaveBeenCalled();
        expect(window.getState().expansions.get('D/')?.entries.map((entry) => entry.path)).toEqual(['D/a.ts']);
    });

    it('refetches on freshness advance and re-resolves expansion state', async () => {
        fetchSnapshotForSessionMock
            .mockResolvedValueOnce(makeCollapsedSnapshot({ fetchedAt: 100 }))
            .mockResolvedValueOnce(makeCollapsedSnapshot({ fetchedAt: 200 }));

        const window = new ScmStatusEntriesWindow({ sessionId: 's1' });
        await window.refresh();
        await window.expandDirectory('D/');
        machineScmStatusEntriesMock.mockClear();

        await window.refresh();

        // One freshness owner: the snapshot advance triggers exactly one
        // snapshot refetch; the stale expansion does not survive it.
        expect(machineScmStatusEntriesMock).not.toHaveBeenCalled();
        expect(fetchSnapshotForSessionMock).toHaveBeenCalledTimes(2);
        expect(window.getState().expansions.size).toBe(0);
        expect(window.getState().status).toBe('ready');
    });

    it('stays idle when the session cannot be resolved to a machine target', async () => {
        resolveRepoScmSessionRequestMock.mockReturnValue(null);

        const window = new ScmStatusEntriesWindow({ sessionId: 's1' });
        await window.refresh();

        expect(fetchSnapshotForSessionMock).not.toHaveBeenCalled();
        expect(window.getState().status).toBe('error');
    });

    it('notifies subscribers on every published state transition', async () => {
        fetchSnapshotForSessionMock.mockResolvedValue(makeCollapsedSnapshot());

        const window = new ScmStatusEntriesWindow({ sessionId: 's1' });
        const listener = vi.fn();
        const unsubscribe = window.subscribe(listener);
        await window.refresh();
        expect(listener.mock.calls.length).toBeGreaterThanOrEqual(2);

        unsubscribe();
        await window.expandDirectory('D/');
        const callsAfterUnsubscribe = listener.mock.calls.length;
        await Promise.resolve();
        expect(listener.mock.calls.length).toBe(callsAfterUnsubscribe);
    });
});
