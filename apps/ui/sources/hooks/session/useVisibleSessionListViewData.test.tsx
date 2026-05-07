import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import type { SessionListViewItem } from '@/sync/domains/state/storage';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

function makeRenderableSession(id: string, overrides: Partial<SessionListRenderableSession> = {}): SessionListRenderableSession {
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: false,
        activeAt: 0,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        ...overrides,
    };
}

const sourceData = vi.hoisted(() => ({
    activeData: [
        {
            type: 'header',
            title: 'Today',
            headerKind: 'date',
            groupKey: 'server:server-a:day:2026-05-04',
            serverId: 'server-a',
        },
        {
            type: 'session',
            session: makeRenderableSession('session-a'),
            section: 'inactive',
            groupKey: 'server:server-a:day:2026-05-04',
            groupKind: 'date',
            serverId: 'server-a',
        },
    ] as SessionListViewItem[],
    hideInactiveSessions: false,
    groupOrder: {} as Record<string, readonly string[] | undefined>,
    pinnedKeys: [] as string[],
    setGroupOrder: vi.fn(),
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useSessionListViewData: () => sourceData.activeData,
            useSessionListViewDataByServerId: () => ({}),
            useSetting: (key: string) => {
                if (key === 'hideInactiveSessions') return sourceData.hideInactiveSessions;
                if (key === 'pinnedSessionKeysV1') return sourceData.pinnedKeys;
                return null;
            },
            useSettingMutable: (key: string) => {
                if (key === 'sessionListGroupOrderV1') {
                    return [sourceData.groupOrder, sourceData.setGroupOrder];
                }
                return [null, vi.fn()];
            },
        },
    });
});

vi.mock('@/hooks/server/useEffectiveServerSelection', () => ({
    useResolvedActiveServerSelection: () => ({
        enabled: false,
        activeServerId: 'server-a',
        allowedServerIds: ['server-a'],
        presentation: 'grouped',
    }),
}));

describe('useVisibleSessionListViewData', () => {
    afterEach(() => {
        sourceData.hideInactiveSessions = false;
        sourceData.activeData = [
            {
                type: 'header',
                title: 'Today',
                headerKind: 'date',
                groupKey: 'server:server-a:day:2026-05-04',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('session-a'),
                section: 'inactive',
                groupKey: 'server:server-a:day:2026-05-04',
                groupKind: 'date',
                serverId: 'server-a',
            },
        ];
        syncPerformanceTelemetry.configure({ enabled: false });
        syncPerformanceTelemetry.reset();
        standardCleanup();
    });

    it('keeps the visible list reference stable across unrelated rerenders', async () => {
        const { useVisibleSessionListViewData } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListViewData());
        const first = hook.getCurrent();

        const second = await hook.rerender();

        expect(second).toBe(first);
        await hook.unmount();
    });

    it('does not compute the unhidden list when hidden inactive filtering still leaves visible sessions', async () => {
        sourceData.hideInactiveSessions = true;
        sourceData.activeData = [
            {
                type: 'header',
                title: 'Today',
                headerKind: 'date',
                groupKey: 'server:server-a:day:2026-05-04',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('session-active', { active: true }),
                section: 'active',
                groupKey: 'server:server-a:day:2026-05-04',
                groupKind: 'date',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('session-inactive'),
                section: 'inactive',
                groupKey: 'server:server-a:day:2026-05-04',
                groupKind: 'date',
                serverId: 'server-a',
            },
        ];
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        const { useVisibleSessionListPaneState } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useVisibleSessionListPaneState());
        const paneState = hook.getCurrent();

        expect(paneState.visibleSessionCount).toBe(1);
        expect(paneState.hasHiddenInactiveSessions).toBe(false);
        await hook.unmount();
    });

    it('does not compute hidden-session availability when the sidebar list is not empty', async () => {
        sourceData.hideInactiveSessions = true;
        sourceData.activeData = [
            {
                type: 'header',
                title: 'Today',
                headerKind: 'date',
                groupKey: 'server:server-a:day:2026-05-04',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('session-active', { active: true }),
                section: 'active',
                groupKey: 'server:server-a:day:2026-05-04',
                groupKind: 'date',
                serverId: 'server-a',
            },
            {
                type: 'session',
                session: makeRenderableSession('session-inactive'),
                section: 'inactive',
                groupKey: 'server:server-a:day:2026-05-04',
                groupKind: 'date',
                serverId: 'server-a',
            },
        ];
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        const { useHasHiddenInactiveSessions } = await import('./useVisibleSessionListViewData');
        const hook = await renderHook(() => useHasHiddenInactiveSessions());

        expect(hook.getCurrent()).toBe(false);
        const visibleComputeEvent = syncPerformanceTelemetry.snapshot().events.find((event) =>
            event.name === 'sync.sessions.list.visible.compute',
        );
        expect(visibleComputeEvent?.count).toBe(1);
        await hook.unmount();
    });
});
