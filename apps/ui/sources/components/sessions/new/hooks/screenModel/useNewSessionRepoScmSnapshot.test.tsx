import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

import { useNewSessionRepoScmSnapshot } from './useNewSessionRepoScmSnapshot';
import { flushHookEffects, renderHook } from '@/dev/testkit';


const readCachedSnapshotForMachinePathMock = vi.hoisted(() => vi.fn());
const fetchSnapshotForMachinePathMock = vi.hoisted(() => vi.fn());
const readCachedWorktreesEnrichmentMock = vi.hoisted(() => vi.fn());
const fetchWorktreesEnrichmentMock = vi.hoisted(() => vi.fn());
const focusEffectRunnerState = vi.hoisted(() => ({
    callback: null as null | (() => void | (() => void)),
}));

vi.mock('@/scm/scmRepositoryService', async () => {
    const actual = await vi.importActual<typeof import('@/scm/scmRepositoryService')>(
        '@/scm/scmRepositoryService',
    );
    return {
        ...actual,
        scmRepositoryService: {
            readCachedSnapshotForMachinePath: readCachedSnapshotForMachinePathMock,
            fetchSnapshotForMachinePath: fetchSnapshotForMachinePathMock,
            readCachedWorktreesEnrichment: readCachedWorktreesEnrichmentMock,
            fetchWorktreesEnrichment: fetchWorktreesEnrichmentMock,
        },
    };
});

vi.mock('@react-navigation/native', () => ({
    useFocusEffect: (callback: () => void | (() => void)) => {
        focusEffectRunnerState.callback = callback;
    },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeSnapshot(partial?: Partial<ScmWorkingSnapshot>): ScmWorkingSnapshot {
    return {
        projectKey: 'machine-a:/repo',
        fetchedAt: 123,
        repo: {
            isRepo: true,
            rootPath: '/repo',
            backendId: 'git',
            mode: '.git',
            worktrees: [],
        },
        capabilities: {
            readStatus: true,
            readDiffFile: true,
            readDiffCommit: true,
            readLog: true,
            writeInclude: true,
            writeExclude: true,
            writeCommit: true,
            writeCommitPathSelection: true,
            writeCommitLineSelection: true,
            writeBackout: true,
            writeRemoteFetch: true,
            writeRemotePull: true,
            writeRemotePush: true,
            worktreeCreate: true,
            changeSetModel: 'index',
            supportedDiffAreas: ['included', 'pending', 'both'],
            operationLabels: undefined,
        },
        branch: { head: 'main', upstream: 'origin/main', ahead: 0, behind: 0, detached: false },
        stashCount: 0,
        hasConflicts: false,
        entries: [],
        totals: {
            includedFiles: 0,
            pendingFiles: 0,
            untrackedFiles: 0,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 0,
            pendingRemoved: 0,
        },
        ...partial,
    };
}

describe('useNewSessionRepoScmSnapshot', () => {
    it('seeds the hook from the cached light snapshot while the refresh request is still in flight', async () => {
        const cachedSnapshot = makeSnapshot({ fetchedAt: 1 });
        let resolveFetch: ((value: ScmWorkingSnapshot | null) => void) | null = null;
        const fetchPromise = new Promise<ScmWorkingSnapshot | null>((resolve) => {
            resolveFetch = resolve;
        });
        readCachedSnapshotForMachinePathMock.mockReturnValue(cachedSnapshot);
        readCachedWorktreesEnrichmentMock.mockReturnValue(null);
        fetchSnapshotForMachinePathMock.mockReturnValue(fetchPromise);
        fetchWorktreesEnrichmentMock.mockResolvedValue(null);

        const hook = await renderHook(() => useNewSessionRepoScmSnapshot({
            machineId: 'machine-a',
            path: '/repo',
        }));

        await act(async () => {
            focusEffectRunnerState.callback?.();
        });

        expect(hook.getCurrent()).toEqual(cachedSnapshot);

        const refreshedSnapshot = makeSnapshot({ fetchedAt: 2 });
        await act(async () => {
            resolveFetch?.(refreshedSnapshot);
        });
        await flushHookEffects();

        expect(hook.getCurrent()).toEqual(refreshedSnapshot);
        await hook.unmount();
    });

    it('fetches the lightweight snapshot FIRST (no includeWorktreeStatus) so the chip can render immediately', async () => {
        readCachedSnapshotForMachinePathMock.mockReturnValue(null);
        readCachedWorktreesEnrichmentMock.mockReturnValue(null);
        fetchSnapshotForMachinePathMock.mockResolvedValue(null);
        fetchWorktreesEnrichmentMock.mockResolvedValue(null);

        const hook = await renderHook(() => useNewSessionRepoScmSnapshot({
            machineId: 'machine-a',
            path: '/repo',
        }));

        await act(async () => {
            focusEffectRunnerState.callback?.();
        });
        await flushHookEffects();

        expect(fetchSnapshotForMachinePathMock).toHaveBeenCalled();
        for (const call of fetchSnapshotForMachinePathMock.mock.calls) {
            // The light fetch MUST NOT request the heavy per-worktree enrichment.
            expect(call[0]).toMatchObject({
                machineId: 'machine-a',
                path: '/repo',
            });
            expect(call[0].includeWorktreeStatus).toBeUndefined();
        }
        await hook.unmount();
    });

    it('schedules the background enrichment after the light snapshot arrives and merges the result into the snapshot', async () => {
        const lightSnapshot = makeSnapshot({
            fetchedAt: 1,
            repo: {
                isRepo: true,
                rootPath: '/repo',
                backendId: 'git',
                mode: '.git',
                worktrees: [
                    { path: '/repo', branch: 'main', isCurrent: true },
                    { path: '/repo/.worktrees/feature', branch: 'feature', isCurrent: false },
                ],
            },
        });
        readCachedSnapshotForMachinePathMock.mockReturnValue(null);
        readCachedWorktreesEnrichmentMock.mockReturnValue(null);
        fetchSnapshotForMachinePathMock.mockResolvedValue(lightSnapshot);
        fetchWorktreesEnrichmentMock.mockResolvedValue([
            { path: '/repo', changeCount: 4, lastActivityAt: 1_700_000_000_000 },
            { path: '/repo/.worktrees/feature', changeCount: 0, lastActivityAt: 1_699_000_000_000 },
        ]);

        const hook = await renderHook(() => useNewSessionRepoScmSnapshot({
            machineId: 'machine-a',
            path: '/repo',
        }));

        await act(async () => {
            focusEffectRunnerState.callback?.();
        });
        await flushHookEffects();

        expect(fetchWorktreesEnrichmentMock).toHaveBeenCalledWith({
            machineId: 'machine-a',
            path: '/repo',
            worktreePaths: ['/repo', '/repo/.worktrees/feature'],
        });

        const final = hook.getCurrent();
        expect(final?.repo.worktrees?.[0]?.changeCount).toBe(4);
        expect(final?.repo.worktrees?.[0]?.lastActivityAt).toBe(1_700_000_000_000);
        expect(final?.repo.worktrees?.[1]?.changeCount).toBe(0);
        expect(final?.repo.worktrees?.[1]?.lastActivityAt).toBe(1_699_000_000_000);
        await hook.unmount();
    });

    it('keeps the light snapshot rendered when the background enrichment fails (graceful degradation)', async () => {
        const lightSnapshot = makeSnapshot({
            fetchedAt: 1,
            repo: {
                isRepo: true,
                rootPath: '/repo',
                backendId: 'git',
                mode: '.git',
                worktrees: [{ path: '/repo', branch: 'main', isCurrent: true }],
            },
        });
        readCachedSnapshotForMachinePathMock.mockReturnValue(null);
        readCachedWorktreesEnrichmentMock.mockReturnValue(null);
        fetchSnapshotForMachinePathMock.mockResolvedValue(lightSnapshot);
        fetchWorktreesEnrichmentMock.mockResolvedValue(null);

        const hook = await renderHook(() => useNewSessionRepoScmSnapshot({
            machineId: 'machine-a',
            path: '/repo',
        }));

        await act(async () => {
            focusEffectRunnerState.callback?.();
        });
        await flushHookEffects();

        const final = hook.getCurrent();
        expect(final?.repo.worktrees?.[0]?.changeCount).toBeUndefined();
        expect(final?.repo.worktrees?.[0]?.path).toBe('/repo');
        await hook.unmount();
    });

    it('seeds with cached enrichment merged onto the cached light snapshot (stale-while-revalidate)', async () => {
        const cachedLight = makeSnapshot({
            fetchedAt: 1,
            repo: {
                isRepo: true,
                rootPath: '/repo',
                backendId: 'git',
                mode: '.git',
                worktrees: [{ path: '/repo', branch: 'main', isCurrent: true }],
            },
        });
        readCachedSnapshotForMachinePathMock.mockReturnValue(cachedLight);
        readCachedWorktreesEnrichmentMock.mockReturnValue([
            { path: '/repo', changeCount: 7, lastActivityAt: 1_700_000_000_000 },
        ]);
        // Hold both fetches so we can inspect the seed value before they resolve.
        let resolveLight: ((v: any) => void) | null = null;
        fetchSnapshotForMachinePathMock.mockReturnValue(new Promise((r) => {
            resolveLight = r;
        }));
        fetchWorktreesEnrichmentMock.mockResolvedValue(null);

        const hook = await renderHook(() => useNewSessionRepoScmSnapshot({
            machineId: 'machine-a',
            path: '/repo',
        }));

        const seed = hook.getCurrent();
        expect(seed?.repo.worktrees?.[0]?.changeCount).toBe(7);
        expect(seed?.repo.worktrees?.[0]?.lastActivityAt).toBe(1_700_000_000_000);

        await act(async () => {
            resolveLight?.(cachedLight);
        });
        await flushHookEffects();
        await hook.unmount();
    });

    it('refreshes the snapshot when the screen regains focus even if machine and path stay the same', async () => {
        let readCount = 0;
        const focusedSnapshot = makeSnapshot({ fetchedAt: 99 });
        const refocusedSnapshot = makeSnapshot({ fetchedAt: 100 });
        readCachedSnapshotForMachinePathMock.mockImplementation(() => {
            readCount += 1;
            if (readCount >= 3) {
                return refocusedSnapshot;
            }
            return readCount >= 2 ? focusedSnapshot : null;
        });
        readCachedWorktreesEnrichmentMock.mockReturnValue(null);
        fetchSnapshotForMachinePathMock
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(focusedSnapshot)
            .mockResolvedValueOnce(refocusedSnapshot);
        fetchWorktreesEnrichmentMock.mockResolvedValue(null);

        const hook = await renderHook(() => useNewSessionRepoScmSnapshot({
            machineId: 'machine-a',
            path: '/repo',
        }));

        await act(async () => {
            focusEffectRunnerState.callback?.();
        });
        await flushHookEffects();

        expect(hook.getCurrent()).toEqual(focusedSnapshot);

        await act(async () => {
            focusEffectRunnerState.callback?.();
        });
        await flushHookEffects();

        expect(hook.getCurrent()).toEqual(refocusedSnapshot);
        expect(fetchSnapshotForMachinePathMock.mock.calls.length).toBeGreaterThanOrEqual(2);
        await hook.unmount();
    });
});
