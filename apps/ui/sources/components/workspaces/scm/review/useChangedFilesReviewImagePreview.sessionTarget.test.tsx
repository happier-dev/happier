import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook } from '@/dev/testkit';

const createSessionFilePreviewSourceSpy = vi.hoisted(() => vi.fn());

const activeServerState = vi.hoisted(() => ({
    snapshot: { serverId: 'server-1', serverUrl: 'https://server-1.example.test', generation: 1 },
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => activeServerState.snapshot,
    subscribeActiveServer: (listener: (snapshot: { serverId: string; serverUrl: string; generation: number }) => void) => {
        listener(activeServerState.snapshot);
        return () => undefined;
    },
}));

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
	        concurrentSessionListCacheByServerId: {} as Record<string, unknown>,
	        getProjectForSession: (_sessionId: string) => null,
	        applySessionListRenderablePatches: () => undefined,
	    },
	}));

vi.mock('@/sync/domains/sessionFilePreviews/createSessionFilePreviewSource', () => ({
    createSessionFilePreviewSource: (...args: unknown[]) => createSessionFilePreviewSourceSpy(...args),
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
    storageSnapshotState.current = {
        ...storageSnapshotState.current,
        sessions: {
            s1: sessionState.current,
        },
        machines: {
            m1: allMachinesState.current[0]!,
        },
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
    storageSnapshotState.current = {
        ...storageSnapshotState.current,
        sessions: {
            s1: sessionState.current,
        },
        machines: {
            m1: allMachinesState.current[0]!,
        },
    };
}

describe('useChangedFilesReviewImagePreview', () => {
    beforeEach(() => {
        createSessionFilePreviewSourceSpy.mockReset();
        createSessionFilePreviewSourceSpy.mockResolvedValue({
            ok: true,
            source: {
                kind: 'object-url',
                uri: 'blob:preview',
                byteLength: 3,
                mimeType: 'image/png',
                revoke: vi.fn(),
            },
        });
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
        expect(createSessionFilePreviewSourceSpy).not.toHaveBeenCalled();

        setSessionWorkspaceAvailable();
        await hook.rerender();
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(createSessionFilePreviewSourceSpy).toHaveBeenCalledWith(expect.objectContaining({
            scope: expect.objectContaining({
                machineId: 'm1',
                rootPath: '/repo',
                serverId: 'server-1',
            }),
            filePath: 'image.png',
            mimeType: 'image/png',
        }));
        expect(hook.getCurrent()).toMatchObject({
            status: 'loaded',
            uri: 'blob:preview',
            error: null,
        });
    });
});
