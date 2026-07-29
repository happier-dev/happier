import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, flushHookEffects, renderHook } from '@/dev/testkit';

const workspaceReadFileSpy = vi.hoisted(() => vi.fn());
const createSessionFilePreviewSourceSpy = vi.hoisted(() => vi.fn());

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

vi.mock('@/sync/domains/sessionFilePreviews/createSessionFilePreviewSource', () => ({
    createSessionFilePreviewSource: (...args: unknown[]) => createSessionFilePreviewSourceSpy(...args),
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
        createSessionFilePreviewSourceSpy.mockReset();
        createSessionFilePreviewSourceSpy.mockResolvedValue({
            ok: true,
            source: {
                kind: 'object-url',
                uri: 'blob:session-preview',
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

        expect(workspaceReadFileSpy).not.toHaveBeenCalled();
        expect(createSessionFilePreviewSourceSpy).toHaveBeenCalledWith(expect.objectContaining({
            scope: expect.objectContaining({
                machineId: 'm1',
                rootPath: '/repo',
                serverId: 'server-1',
            }),
            filePath: '.happier/uploads/messages/m1/file.png',
            mimeType: 'image/png',
            maxBytes: 1_000_000,
            expectedSizeBytes: 3,
            cacheIdentity: 'sha-1',
        }));
        expect(hook.getCurrent()).toMatchObject({
            status: 'loaded',
            uri: 'blob:session-preview',
            error: null,
        });
        expect(hook.getCurrent().uri?.startsWith('data:')).toBe(false);
    });

    it('cleans up a preview source that resolves after unmount', async () => {
        setSessionWorkspaceAvailable();
        const revoke = vi.fn();
        let resolvePreview!: (value: unknown) => void;
        createSessionFilePreviewSourceSpy.mockReturnValue(new Promise((resolve) => {
            resolvePreview = resolve;
        }));

        const { useSessionImagePreview } = await import('./useSessionImagePreview');
        const hook = await renderHook(() => useSessionImagePreview({
            sessionId: 's1',
            filePath: '.happier/uploads/messages/m1/file.png',
            enabled: true,
            cacheKey: null,
            mimeType: 'image/png',
            sizeBytes: 3,
        }));

        await hook.unmount();
        resolvePreview({
            ok: true,
            source: {
                kind: 'object-url',
                uri: 'blob:late-preview',
                byteLength: 3,
                mimeType: 'image/png',
                revoke,
            },
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(revoke).toHaveBeenCalledTimes(1);
    });

    it('keeps one in-flight transfer for equivalent workspace scope objects and publishes its URI once', async () => {
        const preview = createDeferred<{
            ok: true;
            source: {
                kind: 'object-url';
                uri: string;
                byteLength: number;
                mimeType: string;
                revoke: () => void;
            };
        }>();
        const revoke = vi.fn();
        createSessionFilePreviewSourceSpy.mockReturnValue(preview.promise);

        const { useSessionImagePreview } = await import('./useSessionImagePreview');
        const hook = await renderHook(
            ({ workspaceScope }: {
                workspaceScope: { serverId: string; machineId: string; rootPath: string };
            }) => useSessionImagePreview({
                sessionId: 's1',
                filePath: '.happier/uploads/messages/m1/file.png',
                enabled: true,
                cacheKey: null,
                mimeType: 'image/png',
                sizeBytes: 3,
                workspaceScope,
                cacheScopeId: 'server-1:m1:/repo',
            }),
            {
                initialProps: {
                    workspaceScope: { serverId: 'server-1', machineId: 'm1', rootPath: '/repo' },
                },
            },
        );

        expect(createSessionFilePreviewSourceSpy).toHaveBeenCalledTimes(1);

        await hook.rerender({
            workspaceScope: { serverId: 'server-1', machineId: 'm1', rootPath: '/repo' },
        });

        expect(createSessionFilePreviewSourceSpy).toHaveBeenCalledTimes(1);

        preview.resolve({
            ok: true,
            source: {
                kind: 'object-url',
                uri: 'blob:stable-preview',
                byteLength: 3,
                mimeType: 'image/png',
                revoke,
            },
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(hook.getCurrent()).toEqual({
            status: 'loaded',
            uri: 'blob:stable-preview',
            error: null,
        });
        expect(revoke).not.toHaveBeenCalled();

        await hook.unmount();
        expect(revoke).toHaveBeenCalledTimes(1);
    });

    it('releases the prior uncached source when the logical file identity changes', async () => {
        const revokeFirst = vi.fn();
        const revokeSecond = vi.fn();
        createSessionFilePreviewSourceSpy
            .mockResolvedValueOnce({
                ok: true,
                source: {
                    kind: 'object-url',
                    uri: 'blob:first-preview',
                    byteLength: 3,
                    mimeType: 'image/png',
                    revoke: revokeFirst,
                },
            })
            .mockResolvedValueOnce({
                ok: true,
                source: {
                    kind: 'object-url',
                    uri: 'blob:second-preview',
                    byteLength: 4,
                    mimeType: 'image/png',
                    revoke: revokeSecond,
                },
            });

        const workspaceScope = { serverId: 'server-1', machineId: 'm1', rootPath: '/repo' };
        const { useSessionImagePreview } = await import('./useSessionImagePreview');
        const hook = await renderHook(
            ({ filePath }: { filePath: string }) => useSessionImagePreview({
                sessionId: 's1',
                filePath,
                enabled: true,
                cacheKey: null,
                mimeType: 'image/png',
                workspaceScope,
                cacheScopeId: 'server-1:m1:/repo',
            }),
            {
                initialProps: {
                    filePath: '.happier/uploads/messages/m1/first.png',
                },
            },
        );

        expect(hook.getCurrent()).toMatchObject({
            status: 'loaded',
            uri: 'blob:first-preview',
        });

        await hook.rerender({
            filePath: '.happier/uploads/messages/m1/second.png',
        });

        expect(createSessionFilePreviewSourceSpy).toHaveBeenCalledTimes(2);
        expect(revokeFirst).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent()).toMatchObject({
            status: 'loaded',
            uri: 'blob:second-preview',
        });

        await hook.unmount();
        expect(revokeSecond).toHaveBeenCalledTimes(1);
    });
});
