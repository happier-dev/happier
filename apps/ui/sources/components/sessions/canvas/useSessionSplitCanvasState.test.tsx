import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';
import { createSplitCanvasPersistenceSnapshot } from '@/components/appShell/splitCanvas/model/splitCanvasPersistence';
import { resolveSessionSplitCanvasScopeKey, type SessionSplitCanvasScope } from '@/sync/domains/session/sessionSplitCanvasScope';

import {
    collectOpenSessionIds,
    resolveSessionSplitCanvasState,
    runSessionSplitCanvasCommand,
} from './sessionSplitCanvasState';

const storageState = vi.hoisted(() => ({
    isDataReady: false,
    sessionSplitCanvasLayoutsV1: {} as Record<string, unknown>,
}));

const setSessionSplitCanvasLayoutsV1Spy = vi.hoisted(() => vi.fn((value: Record<string, unknown>) => {
    storageState.sessionSplitCanvasLayoutsV1 = value;
}));

vi.mock('@/sync/domains/state/storage', () => {
    const storageMock = createStorageModuleStub({
        useIsDataReady: () => storageState.isDataReady,
        useSettingMutable: (name: string) => {
            if (name !== 'sessionSplitCanvasLayoutsV1') {
                throw new Error(`Unexpected setting mutable lookup: ${name}`);
            }
            return [storageState.sessionSplitCanvasLayoutsV1, setSessionSplitCanvasLayoutsV1Spy] as const;
        },
    });
    return storageMock;
});

function createScope(): SessionSplitCanvasScope {
    return {
        workspaceCacheKey: 'server-a:machine-1:/repo',
        serverId: 'server-a',
        machineId: 'machine-1',
        rootPath: '/repo',
    };
}

function createPersistedSplitSnapshot() {
    const initial = resolveSessionSplitCanvasState({
        sessionId: 'sess_a',
        maxLeaves: 8,
    });
    const withSplit = runSessionSplitCanvasCommand(initial, {
        type: 'openSessionInSplit',
        sessionId: 'sess_b',
        direction: 'right',
    });
    return createSplitCanvasPersistenceSnapshot(withSplit);
}

describe('useSessionSplitCanvasState', () => {
    afterEach(() => {
        storageState.isDataReady = false;
        storageState.sessionSplitCanvasLayoutsV1 = {};
        setSessionSplitCanvasLayoutsV1Spy.mockClear();
        standardCleanup();
    });

    it('does not persist split canvas state while account data is not ready', async () => {
        const { useSessionSplitCanvasState } = await import('./useSessionSplitCanvasState');

        const hook = await renderHook(() => useSessionSplitCanvasState({
            routeSessionId: 'sess_a',
            scope: createScope(),
        }));

        expect(collectOpenSessionIds(hook.getCurrent().state)).toEqual(['sess_a']);
        expect(setSessionSplitCanvasLayoutsV1Spy).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it('restores hydrated persisted split layouts before persisting the current state back', async () => {
        const scope = createScope();
        const scopeKey = resolveSessionSplitCanvasScopeKey(scope);
        if (!scopeKey) {
            throw new Error('Expected a scope key');
        }

        const { useSessionSplitCanvasState } = await import('./useSessionSplitCanvasState');
        const hook = await renderHook(() => useSessionSplitCanvasState({
            routeSessionId: 'sess_a',
            scope,
        }));

        setSessionSplitCanvasLayoutsV1Spy.mockClear();
        storageState.isDataReady = true;
        storageState.sessionSplitCanvasLayoutsV1 = {
            [scopeKey]: createPersistedSplitSnapshot(),
        };

        await hook.rerender(undefined);

        expect(collectOpenSessionIds(hook.getCurrent().state)).toEqual(['sess_a', 'sess_b']);
        expect(setSessionSplitCanvasLayoutsV1Spy).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it('does not re-persist server-normalized split layouts when only JSON key order differs', async () => {
        const scope = createScope();
        const scopeKey = resolveSessionSplitCanvasScopeKey(scope);
        if (!scopeKey) {
            throw new Error('Expected a scope key');
        }

        storageState.isDataReady = true;
        storageState.sessionSplitCanvasLayoutsV1 = {
            [scopeKey]: {
                focusedLeafId: 'session-leaf:sess_a',
                maxLeaves: 8,
                maximizedLeafId: null,
                root: {
                    id: 'session-leaf:sess_a',
                    kind: 'leaf',
                    leafKind: 'session',
                    payload: {
                        sessionId: 'sess_a',
                    },
                },
                version: 1,
            },
        };

        const { useSessionSplitCanvasState } = await import('./useSessionSplitCanvasState');
        const hook = await renderHook(() => useSessionSplitCanvasState({
            routeSessionId: 'sess_a',
            scope,
        }));

        setSessionSplitCanvasLayoutsV1Spy.mockClear();

        await hook.rerender(undefined);

        expect(collectOpenSessionIds(hook.getCurrent().state)).toEqual(['sess_a']);
        expect(setSessionSplitCanvasLayoutsV1Spy).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it('persists split layout changes after the hydrated restore baseline has been established', async () => {
        const scope = createScope();
        const scopeKey = resolveSessionSplitCanvasScopeKey(scope);
        if (!scopeKey) {
            throw new Error('Expected a scope key');
        }

        storageState.isDataReady = true;
        storageState.sessionSplitCanvasLayoutsV1 = {
            [scopeKey]: createSplitCanvasPersistenceSnapshot(resolveSessionSplitCanvasState({
                sessionId: 'sess_a',
                maxLeaves: 8,
            })),
        };

        const { useSessionSplitCanvasState } = await import('./useSessionSplitCanvasState');
        const hook = await renderHook(() => useSessionSplitCanvasState({
            routeSessionId: 'sess_a',
            scope,
        }));

        setSessionSplitCanvasLayoutsV1Spy.mockClear();

        await act(async () => {
            hook.getCurrent().openSessionInSplit({
                sessionId: 'sess_b',
                direction: 'right',
            });
        });

        await vi.waitFor(() => {
            expect(collectOpenSessionIds(hook.getCurrent().state)).toEqual(['sess_a', 'sess_b']);
        });

        await vi.waitFor(() => {
            expect(setSessionSplitCanvasLayoutsV1Spy).toHaveBeenCalledTimes(1);
        });

        const nextLayouts = setSessionSplitCanvasLayoutsV1Spy.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(nextLayouts[scopeKey]).toEqual(expect.objectContaining({
            root: expect.objectContaining({
                kind: 'split',
            }),
            focusedLeafId: 'session-leaf:sess_b',
        }));

        await hook.unmount();
    });
});
