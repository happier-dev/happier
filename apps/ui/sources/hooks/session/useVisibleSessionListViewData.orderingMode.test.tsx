import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

type SessionListOrderingModeV1 = 'custom' | 'created' | 'updated';

const sessionListViewDataState = vi.hoisted(() => ({
    orderingMode: 'updated' as SessionListOrderingModeV1,
    sourceData: null as any,
    serverScopedCache: {} as Record<string, any>,
    selection: {
        enabled: true,
        presentation: 'grouped',
        activeServerId: 's1',
        allowedServerIds: ['s1'],
        explicit: false,
        activeTarget: { kind: 'server', id: 's1', serverId: 's1' },
    } as any,
    groupOrder: {
        'server:s1:day:2026-02-17': ['s1:missing', 's1:a'],
    } as Record<string, string[]>,
    setGroupOrder: vi.fn(),
    observedOrderingMode: [] as Array<SessionListOrderingModeV1>,
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useSessionListViewData: () => sessionListViewDataState.sourceData,
            useServerScopedSessionListCache: () => sessionListViewDataState.serverScopedCache,
            useSetting: ((key: string) => {
                if (key === 'hideInactiveSessions') return false;
                if (key === 'pinnedSessionKeysV1') return [];
                if (key === 'sessionListOrderingModeV1') {
                    sessionListViewDataState.observedOrderingMode.push(sessionListViewDataState.orderingMode);
                    return sessionListViewDataState.orderingMode;
                }
                return null;
            }) as any,
            useSettingMutable: ((key: string) => {
                if (key === 'sessionListGroupOrderV1') {
                    return [sessionListViewDataState.groupOrder, sessionListViewDataState.setGroupOrder];
                }
                return [null, vi.fn()];
            }) as any,
        },
    });
});

vi.mock('@/hooks/server/useEffectiveServerSelection', () => ({
    useResolvedActiveServerSelection: () => sessionListViewDataState.selection,
}));

function makeSession(id: string, partial: Record<string, unknown>): Record<string, unknown> {
    return {
        id,
        active: false,
        createdAt: 0,
        updatedAt: 0,
        ...partial,
    };
}

function makeSourceData(): any[] {
    const groupKey = 'server:s1:day:2026-02-17';
    return [
        { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey },
        { type: 'session', session: makeSession('b', { createdAt: 10, updatedAt: 100 }), serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
        { type: 'session', session: makeSession('a', { createdAt: 20, updatedAt: 200 }), serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
    ];
}

describe('useVisibleSessionListViewData', () => {
    afterEach(() => {
        standardCleanup();
        sessionListViewDataState.orderingMode = 'updated';
        sessionListViewDataState.sourceData = null;
        sessionListViewDataState.serverScopedCache = {};
        sessionListViewDataState.selection = {
            enabled: true,
            presentation: 'grouped',
            activeServerId: 's1',
            allowedServerIds: ['s1'],
            explicit: false,
            activeTarget: { kind: 'server', id: 's1', serverId: 's1' },
        };
        sessionListViewDataState.groupOrder = {
            'server:s1:day:2026-02-17': ['s1:missing', 's1:a'],
        };
        sessionListViewDataState.observedOrderingMode.length = 0;
        sessionListViewDataState.setGroupOrder.mockClear();
    });

    it('keeps dormant manual group order data untouched when ordering mode is updated', async () => {
        sessionListViewDataState.orderingMode = 'updated';
        sessionListViewDataState.sourceData = makeSourceData();

        const { useVisibleSessionListViewData } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListViewData());
        await flushHookEffects();

        const sessionIds = (hook.getCurrent() ?? [])
            .filter((item: any) => item.type === 'session')
            .map((item: any) => item.session.id);

        expect(sessionIds).toEqual(['a', 'b']);
        expect(sessionListViewDataState.observedOrderingMode).toEqual(['updated']);
        expect(sessionListViewDataState.setGroupOrder).not.toHaveBeenCalled();
    });

    it('merges the active source with selected side-server cached rows', async () => {
        sessionListViewDataState.sourceData = [
            { type: 'session', session: makeSession('active-1', { createdAt: 10, updatedAt: 100 }), serverId: 's1', section: 'active', groupKey: 'server:s1:active', groupKind: 'server' },
        ];
        sessionListViewDataState.serverScopedCache = {
            s1: sessionListViewDataState.sourceData,
            s2: [
                { type: 'session', session: makeSession('cached-1', { createdAt: 20, updatedAt: 200 }), serverId: 's2', section: 'active', groupKey: 'server:s2:active', groupKind: 'server' },
            ],
        };
        sessionListViewDataState.selection = {
            enabled: true,
            presentation: 'grouped',
            activeServerId: 's1',
            allowedServerIds: ['s1', 's2'],
            explicit: false,
            activeTarget: { kind: 'server', id: 's1', serverId: 's1' },
        } as any;

        const { useVisibleSessionListViewData } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListViewData());
        await flushHookEffects();

        expect((hook.getCurrent() ?? [])
            .filter((item: any) => item.type === 'session')
            .map((item: any) => item.session.id)).toEqual([
            'active-1',
            'cached-1',
        ]);
    });
});
