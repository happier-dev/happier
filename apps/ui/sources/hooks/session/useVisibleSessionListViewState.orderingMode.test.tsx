import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';

type SessionListOrderingModeV1 = 'custom' | 'created' | 'updated';

const viewState = vi.hoisted(() => ({
    orderingMode: 'updated' as SessionListOrderingModeV1,
    hideInactiveSessions: false,
    selection: {
        enabled: true,
        presentation: 'grouped',
        activeServerId: 's1',
        allowedServerIds: ['s1'],
        explicit: false,
        activeTarget: { kind: 'server', id: 's1', serverId: 's1' },
    } as any,
    source: null as SessionListIndexItem[] | null,
    groupOrder: {
        'server:s1:day:2026-02-17': ['s1:missing', 's1:a'],
    } as Record<string, string[]>,
    setGroupOrder: vi.fn(),
    rowsByServerId: {} as Record<string, Record<string, SessionListRenderableSession>>,
    observedOrderingMode: [] as Array<SessionListOrderingModeV1>,
}));

function makeSessionRow(id: string, partial?: Partial<SessionListRenderableSession>): SessionListRenderableSession {
    return {
        id,
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: false,
        activeAt: 0,
        archivedAt: null,
        pendingVersion: undefined,
        pendingCount: undefined,
        metadataVersion: 0,
        agentStateVersion: 0,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 0,
        owner: undefined,
        accessLevel: undefined,
        canApprovePermissions: undefined,
        hasPendingPermissionRequests: undefined,
        hasPendingUserActionRequests: undefined,
        hasUnreadMessages: false,
        keepVisibleWhenInactive: false,
        ...(partial ?? {}),
    };
}

function makeSourceIndex(): SessionListIndexItem[] {
    const groupKey = 'server:s1:day:2026-02-17';
    return [
        { type: 'header', headerKind: 'date', title: 'Today', serverId: 's1', groupKey },
        { type: 'session', sessionId: 'b', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
        { type: 'session', sessionId: 'a', serverId: 's1', section: 'inactive', groupKey, groupKind: 'date' },
    ];
}

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useSessionListRowStateByServerId: () => viewState.rowsByServerId,
            useSetting: ((key: string) => {
                if (key === 'hideInactiveSessions') return viewState.hideInactiveSessions;
                if (key === 'pinnedSessionKeysV1') return [];
                if (key === 'sessionListOrderingModeV1') {
                    viewState.observedOrderingMode.push(viewState.orderingMode);
                    return viewState.orderingMode;
                }
                return null;
            }) as any,
            useSettingMutable: ((key: string) => {
                if (key === 'sessionListGroupOrderV1') {
                    return [viewState.groupOrder, viewState.setGroupOrder];
                }
                return [null, vi.fn()];
            }) as any,
        },
    });
});

vi.mock('./useVisibleSessionListSourceState', () => ({
    useVisibleSessionListSourceState: () => ({
        selection: viewState.selection,
        activeIndex: viewState.source,
        byServerId: {},
        source: viewState.source,
    }),
}));

describe('useVisibleSessionListViewState (index pipeline)', () => {
    afterEach(() => {
        standardCleanup();
        viewState.orderingMode = 'updated';
        viewState.source = null;
        viewState.selection = {
            enabled: true,
            presentation: 'grouped',
            activeServerId: 's1',
            allowedServerIds: ['s1'],
            explicit: false,
            activeTarget: { kind: 'server', id: 's1', serverId: 's1' },
        };
        viewState.groupOrder = {
            'server:s1:day:2026-02-17': ['s1:missing', 's1:a'],
        };
        viewState.hideInactiveSessions = false;
        viewState.rowsByServerId = {};
        viewState.observedOrderingMode.length = 0;
        viewState.setGroupOrder.mockClear();
    });

    it('keeps dormant manual group order data untouched when ordering mode is updated', async () => {
        viewState.orderingMode = 'updated';
        viewState.source = makeSourceIndex();
        viewState.rowsByServerId = {
            s1: {
                a: makeSessionRow('a', { createdAt: 20, updatedAt: 200 }),
                b: makeSessionRow('b', { createdAt: 10, updatedAt: 100 }),
            },
        };

        const { useVisibleSessionListViewState } = await import('./useVisibleSessionListViewState');
        const hook = await renderHook(() => useVisibleSessionListViewState('all'));
        await flushHookEffects();

        const sessionIds = (hook.getCurrent()?.visibleSessionListIndex ?? [])
            .filter((item) => item.type === 'session')
            .map((item) => (item as Extract<SessionListIndexItem, { type: 'session' }>).sessionId);

        expect(sessionIds).toEqual(['a', 'b']);
        expect(viewState.observedOrderingMode).toEqual(['updated']);
        expect(viewState.setGroupOrder).not.toHaveBeenCalled();
    });

    it('exposes when the inactive filter hides all visible sessions', async () => {
        viewState.hideInactiveSessions = true;
        viewState.source = [
            { type: 'session', sessionId: 'inactive', serverId: 's1', section: 'inactive', groupKey: 'server:s1:day:2026-02-17', groupKind: 'date' },
        ];
        viewState.rowsByServerId = {
            s1: {
                inactive: makeSessionRow('inactive', { active: false, keepVisibleWhenInactive: false }),
            },
        };

        const { useVisibleSessionListViewState } = await import('./useVisibleSessionListViewState');
        const hook = await renderHook(() => useVisibleSessionListViewState('all'));
        await flushHookEffects();

        expect(hook.getCurrent()?.visibleSessionListIndex).toEqual([]);
        expect(hook.getCurrent()?.hasHiddenInactiveSessions).toBe(true);
    });
});
