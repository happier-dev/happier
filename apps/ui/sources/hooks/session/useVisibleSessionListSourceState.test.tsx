import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

const sourceState = vi.hoisted(() => ({
    equivalentPairs: new Set<string>(),
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
    querySource: {
        statesByServerId: {},
        byServerId: {},
        source: null as SessionListIndexItem[] | null,
        coverageComplete: false,
        loadNext: vi.fn(),
        refresh: vi.fn(),
    },
    queryInputs: [] as unknown[],
}));

function equivalentPairKey(left: string, right: string): string {
    return [left, right].sort().join('\u0000');
}

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => ({
    // The real storage module is imported below, so the whole runtime graph under it
    // still needs every genuine profile export; only identity equivalence is stubbed.
    ...await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>(),
    areServerProfileIdentifiersEquivalent: (leftRaw: string | null | undefined, rightRaw: string | null | undefined) => {
        const left = String(leftRaw ?? '').trim();
        const right = String(rightRaw ?? '').trim();
        if (!left || !right) return false;
        if (left === right) return true;
        return sourceState.equivalentPairs.has(equivalentPairKey(left, right));
    },
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

vi.mock('@/sync/domains/session/listing/useSessionListQuerySourceState', () => ({
    useSessionListQuerySourceState: (input: unknown) => {
        sourceState.queryInputs.push(input);
        return sourceState.querySource;
    },
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
        sourceState.equivalentPairs.clear();
        sourceState.selectedIndexRequests = [];
        sourceState.querySource = {
            statesByServerId: {},
            byServerId: {},
            source: null,
            coverageComplete: false,
            loadNext: vi.fn(),
            refresh: vi.fn(),
        };
        sourceState.queryInputs = [];
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

    it('keeps the active index visible when the selected server id is an equivalent identity alias', async () => {
        sourceState.selection = {
            enabled: true,
            presentation: 'grouped',
            activeServerId: 'srv-active-identity',
            allowedServerIds: ['srv-active-identity'],
            explicit: false,
            activeTarget: { kind: 'server', id: 'srv-active-identity', serverId: 'srv-active-identity' },
        };
        sourceState.equivalentPairs.add(equivalentPairKey('srv-active-identity', 'localhost-53288'));
        sourceState.byServerId = {
            'localhost-53288': [
                {
                    type: 'session',
                    sessionId: 'alias-created-session',
                    serverId: 'localhost-53288',
                    serverName: 'localhost:53288',
                },
            ],
        };

        const { useVisibleSessionListSourceState } = await import('./useVisibleSessionListSourceState');
        const hook = await renderHook(() => useVisibleSessionListSourceState());
        await flushHookEffects();

        expect(hook.getCurrent().activeIndex?.map((item) => item.type === 'session' ? item.sessionId : item.type)).toEqual([
            'alias-created-session',
        ]);
        expect(hook.getCurrent().source?.map((item) => item.type === 'session' ? item.sessionId : item.type)).toEqual([
            'alias-created-session',
        ]);
        expect(sourceState.selectedIndexRequests).toEqual([['srv-active-identity']]);
    });

    it('uses qualified query membership as the list source when query Homes are supplied', async () => {
        const queryHomes = [{
            serverId: 'srv-b',
            queryKey: 'query-b',
            query: {
                v: 1 as const,
                storage: 'active' as const,
                includeInactive: false,
                scope: 'my_work' as const,
                attention: 'any' as const,
                audiences: [],
                tagIds: [],
            },
        }];
        sourceState.querySource = {
            statesByServerId: {},
            byServerId: { 'srv-b': [{ type: 'session', sessionId: 'query-only', serverId: 'srv-b' }] },
            source: [{ type: 'session', sessionId: 'query-only', serverId: 'srv-b' }],
            coverageComplete: true,
            loadNext: vi.fn(),
            refresh: vi.fn(),
        };

        const { useVisibleSessionListSourceState } = await import('./useVisibleSessionListSourceState');
        const hook = await renderHook(() => useVisibleSessionListSourceState({ queryHomes }));
        await flushHookEffects();

        expect(hook.getCurrent().source).toEqual(sourceState.querySource.source);
        expect(hook.getCurrent().activeIndex).toBeNull();
        expect(hook.getCurrent().query).toMatchObject({ active: true, coverageComplete: true });
        expect(sourceState.queryInputs).toEqual([{
            enabled: true,
            homes: queryHomes,
            emptySelectionComplete: false,
            agentTargetDemand: false,
        }]);
    });

    it('treats an empty query Home set as an intentionally empty filtered corpus', async () => {
        sourceState.querySource = {
            statesByServerId: {},
            byServerId: {},
            source: [],
            coverageComplete: false,
            loadNext: vi.fn(),
            refresh: vi.fn(),
        };

        const { useVisibleSessionListSourceState } = await import('./useVisibleSessionListSourceState');
        const hook = await renderHook(() => useVisibleSessionListSourceState({ queryHomes: [] }));
        await flushHookEffects();

        expect(hook.getCurrent().source).toEqual([]);
        expect(hook.getCurrent().query.active).toBe(true);
        expect(sourceState.queryInputs).toEqual([{
            enabled: true,
            homes: [],
            emptySelectionComplete: false,
            agentTargetDemand: false,
        }]);
    });
});
