import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

const sourceState = vi.hoisted(() => ({
    selectedIndexRequests: [] as Array<ReadonlyArray<string> | undefined>,
    selection: {
        enabled: true,
        presentation: 'grouped',
        activeServerId: 'srv-a',
        allowedServerIds: ['srv-a', 'srv-b'],
        explicit: false,
        activeTarget: { kind: 'server', id: 'srv-a', serverId: 'srv-a' },
    } as any,
    activeIndex: [
        {
            type: 'session',
            sessionId: 'active-1',
            serverId: 'srv-a',
            serverName: 'Server A',
        },
    ] as SessionListIndexItem[],
    byServerId: {
        'srv-a': [
            {
                type: 'session',
                sessionId: 'active-1',
                serverId: 'srv-a',
                serverName: 'Server A',
            },
        ],
        'srv-b': [
            {
                type: 'session',
                sessionId: 'cached-1',
                serverId: 'srv-b',
                serverName: 'Server B',
            },
        ] as SessionListIndexItem[],
    } as Record<string, SessionListIndexItem[]>,
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useSessionListIndexByServerId: (serverIds?: ReadonlyArray<string>) => {
                sourceState.selectedIndexRequests.push(serverIds);
                return sourceState.byServerId;
            },
        },
    });
});

vi.mock('./useSessionListSelectionState', () => ({
    useSessionListSelectionState: () => sourceState.selection,
}));

describe('useVisibleSessionListSourceState', () => {
    afterEach(() => {
        standardCleanup();
        sourceState.selection = {
            enabled: true,
            presentation: 'grouped',
            activeServerId: 'srv-a',
            allowedServerIds: ['srv-a', 'srv-b'],
            explicit: false,
            activeTarget: { kind: 'server', id: 'srv-a', serverId: 'srv-a' },
        };
        sourceState.activeIndex = [
            {
                type: 'session',
                sessionId: 'active-1',
                serverId: 'srv-a',
                serverName: 'Server A',
            },
        ] as SessionListIndexItem[];
        sourceState.byServerId = {
            'srv-a': [
                {
                    type: 'session',
                    sessionId: 'active-1',
                    serverId: 'srv-a',
                    serverName: 'Server A',
                },
            ] as SessionListIndexItem[],
            'srv-b': [
                {
                    type: 'session',
                    sessionId: 'cached-1',
                    serverId: 'srv-b',
                    serverName: 'Server B',
                },
            ] as SessionListIndexItem[],
        } as Record<string, SessionListIndexItem[]>;
        sourceState.selectedIndexRequests = [];
    });

    it('returns the canonical selection together with the resolved visible source', async () => {
        const { useVisibleSessionListSourceState } = await import('./useVisibleSessionListSourceState');
        const hook = await renderHook(() => useVisibleSessionListSourceState());
        await flushHookEffects();

        expect(hook.getCurrent()).toEqual(expect.objectContaining({
            selection: sourceState.selection,
            source: expect.arrayContaining([
                expect.objectContaining({ serverId: 'srv-a' }),
                expect.objectContaining({ serverId: 'srv-b' }),
            ]),
        }));
        expect(hook.getCurrent()?.source?.map((item) => item.type === 'session' ? item.sessionId : item.type)).toEqual(['active-1', 'cached-1']);
        expect(sourceState.selectedIndexRequests).toEqual([['srv-a', 'srv-b']]);
    });

    it('keeps the active server index subscribed when selection presentation is disabled', async () => {
        sourceState.selection = {
            enabled: false,
            presentation: 'single',
            activeServerId: 'srv-a',
            allowedServerIds: ['srv-a'],
            explicit: false,
            activeTarget: { kind: 'server', id: 'srv-a', serverId: 'srv-a' },
        };

        const { useVisibleSessionListSourceState } = await import('./useVisibleSessionListSourceState');
        const hook = await renderHook(() => useVisibleSessionListSourceState());
        await flushHookEffects();

        expect(hook.getCurrent().activeIndex?.map((item) => item.type === 'session' ? item.sessionId : item.type)).toEqual(['active-1']);
        expect(hook.getCurrent().source?.map((item) => item.type === 'session' ? item.sessionId : item.type)).toEqual(['active-1']);
        expect(sourceState.selectedIndexRequests).toEqual([['srv-a']]);
    });
});
