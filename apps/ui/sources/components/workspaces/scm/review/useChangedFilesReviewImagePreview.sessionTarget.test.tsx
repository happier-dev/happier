import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook } from '@/dev/testkit';

const workspaceReadFileSpy = vi.hoisted(() => vi.fn());

const sessionState = vi.hoisted(() => ({
    current: null as null | {
        active: boolean;
        serverId: string;
        metadata: {
            machineId?: string | null;
            path?: string | null;
            host?: string | null;
            homeDir?: string | null;
        };
    },
}));

const allSessionsState = vi.hoisted(() => ({
    current: [] as Array<{
        id: string;
        active: boolean;
        serverId: string;
        metadata: {
            machineId?: string | null;
            path?: string | null;
            host?: string | null;
            homeDir?: string | null;
        };
    }>,
}));

const allMachinesState = vi.hoisted(() => ({
    current: [] as Array<{
        id: string;
        active: boolean;
        activeAt: number;
        metadata: {
            host?: string | null;
            homeDir?: string | null;
        };
    }>,
}));

const storageSnapshotState = vi.hoisted(() => ({
    current: {
        sessions: {} as Record<string, unknown>,
        machines: {} as Record<string, unknown>,
        sessionListViewDataByServerId: {} as Record<string, unknown>,
        getProjectForSession: (_sessionId: string) => null,
        applySessionListRenderablePatches: () => undefined,
    },
}));

vi.mock('@/sync/ops/workspaceFileSystem', () => ({
    workspaceReadFile: (target: unknown, path: string) => workspaceReadFileSpy(target, path),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');

    return createStorageModuleStub({
        storage: Object.assign(
            ((selector?: (value: typeof storageSnapshotState.current) => unknown) =>
                typeof selector === 'function' ? selector(storageSnapshotState.current) : storageSnapshotState.current),
            {
                getState: () => storageSnapshotState.current,
                getInitialState: () => storageSnapshotState.current,
                setState: () => undefined,
                subscribe: () => () => undefined,
                destroy: () => undefined,
            },
        ),
        useSetting: (key: string) => {
            if (key === 'filesImagePreviewCacheMaxEntries') return 10;
            if (key === 'filesImagePreviewCacheMaxTotalBytes') return 1_000_000;
            if (key === 'filesImagePreviewMaxBytes') return 1_000_000;
            return null;
        },
        useSession: () => sessionState.current,
        useAllSessions: () => allSessionsState.current,
        useAllMachines: () => allMachinesState.current,
        useProjectForSession: () => null,
    });
});

function setSessionWorkspaceUnavailable() {
    sessionState.current = {
        active: true,
        serverId: 'server-1',
        metadata: {
            machineId: null,
            path: null,
            host: 'mbp',
            homeDir: '/Users/test',
        },
    };
    allSessionsState.current = [{
        id: 's1',
        active: true,
        serverId: 'server-1',
        metadata: {
            machineId: null,
            path: null,
            host: 'mbp',
            homeDir: '/Users/test',
        },
    }];
    allMachinesState.current = [{
        id: 'm1',
        active: true,
        activeAt: 1,
        metadata: {
            host: 'mbp',
            homeDir: '/Users/test',
        },
    }];
    storageSnapshotState.current.sessions = {
        s1: sessionState.current,
    };
    storageSnapshotState.current.machines = {
        m1: allMachinesState.current[0]!,
    };
}

function setSessionWorkspaceAvailable() {
    sessionState.current = {
        active: true,
        serverId: 'server-1',
        metadata: {
            machineId: 'm1',
            path: '/repo',
            host: 'mbp',
            homeDir: '/Users/test',
        },
    };
    allSessionsState.current = [{
        id: 's1',
        active: true,
        serverId: 'server-1',
        metadata: {
            machineId: 'm1',
            path: '/repo',
            host: 'mbp',
            homeDir: '/Users/test',
        },
    }];
    allMachinesState.current = [{
        id: 'm1',
        active: true,
        activeAt: 1,
        metadata: {
            host: 'mbp',
            homeDir: '/Users/test',
        },
    }];
    storageSnapshotState.current.sessions = {
        s1: sessionState.current,
    };
    storageSnapshotState.current.machines = {
        m1: allMachinesState.current[0]!,
    };
}

describe('useChangedFilesReviewImagePreview', () => {
    beforeEach(() => {
        workspaceReadFileSpy.mockReset();
        workspaceReadFileSpy.mockResolvedValue({ success: true, content: 'YWJj' });
        setSessionWorkspaceUnavailable();
    });

    afterEach(() => {
        vi.resetModules();
    });

    it('retries image preview loading when the session workspace target appears after mount', async () => {
        const { useChangedFilesReviewImagePreview } = await import('./useChangedFilesReviewImagePreview');

        const hook = await renderHook(() => useChangedFilesReviewImagePreview({
            sessionId: 's1',
            snapshotSignature: 'sig-1',
            filePath: 'image.png',
            enabled: true,
        }));

        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(hook.getCurrent()).toMatchObject({
            status: 'loading',
            uri: null,
            error: null,
        });
        expect(workspaceReadFileSpy).not.toHaveBeenCalled();

        setSessionWorkspaceAvailable();
        await hook.rerender();
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(workspaceReadFileSpy).toHaveBeenCalledWith(expect.objectContaining({
            workspaceCacheKey: 'server-1:m1:/repo',
            machineId: 'm1',
            rootPath: '/repo',
            serverId: 'server-1',
        }), 'image.png');
        expect(hook.getCurrent()).toMatchObject({
            status: 'loaded',
            uri: 'data:image/png;base64,YWJj',
            error: null,
        });
    });
});
