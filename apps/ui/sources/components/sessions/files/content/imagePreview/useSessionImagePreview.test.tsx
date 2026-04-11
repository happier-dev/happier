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
	        concurrentSessionListCacheByServerId: {} as Record<string, unknown>,
	        getProjectForSession: (_sessionId: string) => null,
	        applySessionListRenderablePatches: () => undefined,
	    },
	}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/sync/ops/workspaceFileSystem', () => ({
    workspaceReadFile: (...args: unknown[]) => workspaceReadFileSpy(...args),
}));

vi.mock('@/sync/store/hooks', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/store/hooks')>();
    return {
        ...actual,
        useSessionServerId: () => sessionState.current?.serverId ?? null,
    };
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

describe('useSessionImagePreview', () => {
    beforeEach(() => {
        workspaceReadFileSpy.mockReset();
        workspaceReadFileSpy.mockResolvedValue({ success: true, content: 'YWJj' });
        setSessionWorkspaceUnavailable();
    });

    afterEach(() => {
        vi.resetModules();
    });

    it('waits for the session workspace target and retries once it becomes available', async () => {
        const { useSessionImagePreview } = await import('./useSessionImagePreview');

        const hook = await renderHook(() => useSessionImagePreview({
            sessionId: 's1',
            filePath: '.happier/uploads/messages/m1/file.png',
            enabled: true,
            cacheKey: 'sha-1',
            mimeType: 'image/png',
            sizeBytes: 3,
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

        expect(workspaceReadFileSpy).toHaveBeenCalledWith({
            machineId: 'm1',
            rootPath: '/repo',
            serverId: 'server-1',
        }, '.happier/uploads/messages/m1/file.png', { maxBytes: 3 });
        expect(hook.getCurrent()).toMatchObject({
            status: 'loaded',
            uri: 'data:image/png;base64,YWJj',
            error: null,
        });
    });
});
