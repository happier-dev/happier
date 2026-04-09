import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

const sourceState = vi.hoisted(() => ({
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
            useSessionListIndexByServerId: () => sourceState.byServerId,
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
    });
});
