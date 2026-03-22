import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

import { useNewSessionRepoScmSnapshot } from './useNewSessionRepoScmSnapshot';
import { renderScreen } from '@/dev/testkit';


const readCachedSnapshotForMachinePathMock = vi.hoisted(() => vi.fn());
const fetchSnapshotForMachinePathMock = vi.hoisted(() => vi.fn());
const focusEffectRunnerState = vi.hoisted(() => ({
    callback: null as null | (() => void | (() => void)),
}));

vi.mock('@/scm/scmRepositoryService', () => ({
    scmRepositoryService: {
        readCachedSnapshotForMachinePath: readCachedSnapshotForMachinePathMock,
        fetchSnapshotForMachinePath: fetchSnapshotForMachinePathMock,
    },
}));

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

async function flushAsync(): Promise<void> {
    await Promise.resolve();
}

async function renderHook<T>(useValue: () => T): Promise<{
    result: { current: T };
    unmount: () => void;
}> {
    const result: { current: T } = { current: undefined as T };
    focusEffectRunnerState.callback = null;

    function Test() {
        result.current = useValue();
        return null;
    }

    let root: renderer.ReactTestRenderer | null = null;
    root = (await renderScreen(React.createElement(Test))).tree;

    await act(async () => {
        focusEffectRunnerState.callback?.();
        await flushAsync();
    });

    return {
        result,
        unmount: () => {
            if (!root) return;
            act(() => {
                root?.unmount();
            });
        },
    };
}

describe('useNewSessionRepoScmSnapshot', () => {
    it('seeds the hook from the cached machine/path snapshot while the refresh request is still in flight', async () => {
        const cachedSnapshot = makeSnapshot({ fetchedAt: 1 });
        let resolveFetch: ((value: ScmWorkingSnapshot | null) => void) | null = null;
        const fetchPromise = new Promise<ScmWorkingSnapshot | null>((resolve) => {
            resolveFetch = resolve;
        });
        readCachedSnapshotForMachinePathMock.mockReturnValue(cachedSnapshot);
        fetchSnapshotForMachinePathMock.mockReturnValue(fetchPromise);

        const hook = await renderHook(() => useNewSessionRepoScmSnapshot({
            machineId: 'machine-a',
            path: '/repo',
        }));

        expect(hook.result.current).toEqual(cachedSnapshot);

        const refreshedSnapshot = makeSnapshot({ fetchedAt: 2 });
        await act(async () => {
            resolveFetch?.(refreshedSnapshot);
            await flushAsync();
        });

        expect(hook.result.current).toEqual(refreshedSnapshot);
        hook.unmount();
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
        fetchSnapshotForMachinePathMock
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(focusedSnapshot)
            .mockResolvedValueOnce(refocusedSnapshot);

        const hook = await renderHook(() => useNewSessionRepoScmSnapshot({
            machineId: 'machine-a',
            path: '/repo',
        }));

        expect(hook.result.current).toEqual(focusedSnapshot);

        await act(async () => {
            focusEffectRunnerState.callback?.();
            await flushAsync();
        });

        expect(hook.result.current).toEqual(refocusedSnapshot);
        expect(fetchSnapshotForMachinePathMock.mock.calls.length).toBeGreaterThanOrEqual(2);
        hook.unmount();
    });
});
