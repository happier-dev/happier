import { beforeEach, describe, expect, it, vi } from 'vitest';

import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { createMessagesDomain } from './messages';

vi.mock('../../domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'server-active', serverUrl: 'https://example.com', generation: 1 }),
}));

function createHarness(initial: any) {
    let state: any = {
        sessions: {},
        sessionPending: {},
        sessionMessages: {},
        sessionListRenderables: {},
        sessionListRowStateByServerId: {},
        sessionListIndexByServerId: {},
        concurrentSessionListCacheByServerId: {},
        machines: {},
        machineDisplayById: {},
        profile: { id: 'account_a' },
        settings: { groupInactiveSessionsByProject: false },
        getProjectForSession: () => null,
        ...initial,
    };

    const get = () => state;
    const set = (updater: any) => {
        const next = typeof updater === 'function' ? updater(state) : updater;
        state = { ...state, ...next };
    };

    const domain = createMessagesDomain({ get, set } as any);
    return { get, domain };
}

function buildStreamSegmentMeta(updatedAtMs: number) {
    return {
        happierStreamSegmentV1: {
            v: 1,
            segmentKind: 'assistant',
            segmentLocalId: 'assistant-segment-1',
            segmentState: 'streaming',
            startedAtMs: 1_000,
            updatedAtMs,
        },
    };
}

beforeEach(() => {
    syncPerformanceTelemetry.configure({ enabled: false });
});

describe('messages domain: ordering', () => {
    it('advances the stored session and renderable unread state from committed message activity', () => {
        const { get, domain } = createHarness({
            sessions: {
                s1: {
                    id: 's1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    lastViewedSessionSeq: 1,
                    metadataVersion: 1,
                    agentStateVersion: 1,
                    metadata: null,
                    agentState: null,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                    permissionMode: null,
                    permissionModeUpdatedAt: 0,
                },
            },
            sessionListRenderables: {
                s1: {
                    id: 's1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    lastViewedSessionSeq: 1,
                    metadataVersion: 1,
                    agentStateVersion: 1,
                    metadata: null,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                    hasUnreadMessages: false,
                },
            },
        });

        domain.applyMessages('s1', [
            {
                id: 'm3',
                seq: 3,
                localId: null,
                createdAt: 1000,
                isSidechain: false,
                role: 'agent',
                content: [{ type: 'text', text: 'done' }],
            } as any,
        ]);

        expect(get().sessions.s1.seq).toBe(3);
        expect(get().sessionListRenderables.s1.seq).toBe(3);
        expect(get().sessionListRenderables.s1.hasUnreadMessages).toBe(true);
    });

    it('persists ready-event metadata from filtered ready events into active-server row projections', () => {
        const session = {
            id: 's1',
            serverId: 'server-active',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            lastViewedSessionSeq: 1,
            metadataVersion: 1,
            agentStateVersion: 1,
            metadata: null,
            agentState: null,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
            permissionMode: null,
            permissionModeUpdatedAt: 0,
        };
        const renderable = {
            id: 's1',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            lastViewedSessionSeq: 1,
            metadataVersion: 1,
            agentStateVersion: 1,
            metadata: null,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
            hasUnreadMessages: false,
        };
        const { get, domain } = createHarness({
            sessions: { s1: session },
            sessionListRenderables: { s1: renderable },
            sessionListRowStateByServerId: { 'server-active': { s1: renderable } },
            sessionListIndexByServerId: {
                'server-active': [
                    {
                        type: 'session',
                        sessionId: 's1',
                        serverId: 'server-active',
                        groupKey: 'active',
                        groupKind: 'active',
                        variant: 'default',
                    },
                ],
            },
        });

        const initialIndex = get().sessionListIndexByServerId['server-active'];
        const result = domain.applyMessages('s1', [
            {
                id: 'ready-1',
                seq: 9,
                localId: null,
                createdAt: 9000,
                isSidechain: false,
                role: 'event',
                content: { type: 'ready' },
            } as any,
        ]);

        expect(result).toEqual({
            changed: [],
            hasReadyEvent: true,
            latestReadyEventSeq: 9,
            latestReadyEventAt: 9000,
        });
        expect(get().sessionMessages.s1.latestReadyEventSeq).toBe(9);
        expect(get().sessionMessages.s1.latestReadyEventAt).toBe(9000);
        expect(get().sessions.s1.latestReadyEventSeq).toBe(9);
        expect(get().sessions.s1.latestReadyEventAt).toBe(9000);
        expect(get().sessionListRenderables.s1.latestReadyEventSeq).toBe(9);
        expect(get().sessionListRenderables.s1.latestReadyEventAt).toBe(9000);
        expect(get().sessionListRowStateByServerId['server-active'].s1.latestReadyEventSeq).toBe(9);
        expect(get().sessionListIndexByServerId['server-active']).toBe(initialIndex);

        const nextIndex = get().sessionListIndexByServerId['server-active'];
        const duplicateResult = domain.applyMessages('s1', [
            {
                id: 'ready-1',
                seq: 9,
                localId: null,
                createdAt: 9000,
                isSidechain: false,
                role: 'event',
                content: { type: 'ready' },
            } as any,
        ]);

        expect(duplicateResult).toEqual({ changed: [], hasReadyEvent: false });
        expect(get().sessionListIndexByServerId['server-active']).toBe(nextIndex);
    });

    it('orders committed transcript messages by seq when available (oldest first)', () => {
        const { get, domain } = createHarness({
            sessions: {
                s1: {
                    id: 's1',
                    createdAt: 1,
                    active: false,
                    activeAt: 1,
                    metadataVersion: 1,
                    metadata: null,
                    permissionMode: null,
                    permissionModeUpdatedAt: 0,
                },
            },
        });

        domain.applyMessages('s1', [
            {
                id: 'm1',
                seq: 1,
                localId: null,
                createdAt: 1000,
                isSidechain: false,
                role: 'user',
                content: { type: 'text', text: 'first' },
            } as any,
            {
                id: 'm2',
                seq: 2,
                localId: null,
                createdAt: 1000,
                isSidechain: false,
                role: 'user',
                content: { type: 'text', text: 'second' },
            } as any,
        ]);

        const ids = get().sessionMessages.s1.messageIdsOldestFirst;
        expect(ids).toHaveLength(2);
        const first = get().sessionMessages.s1.messagesById[ids[0]!] as any;
        const second = get().sessionMessages.s1.messagesById[ids[1]!] as any;
        expect(first?.kind).toBe('user-text');
        expect(first?.seq).toBe(1);
        expect(first?.text).toBe('first');
        expect(second?.kind).toBe('user-text');
        expect(second?.seq).toBe(2);
        expect(second?.text).toBe('second');
    });

    it('clears matching local optimistic pending rows but keeps unresolved server pending rows when a transcript message commits with the same localId', () => {
        const { get, domain } = createHarness({
            sessions: {
                s1: {
                    id: 's1',
                    createdAt: 1,
                    active: false,
                    activeAt: 1,
                    metadataVersion: 1,
                    metadata: null,
                    permissionMode: null,
                    permissionModeUpdatedAt: 0,
                    agentState: null,
                },
            },
            sessionPending: {
                s1: {
                    isLoaded: true,
                    discarded: [],
                    messages: [
                        {
                            id: 'pending-server-local-1',
                            localId: 'local-1',
                            source: 'server_pending',
                            pendingDeliveryStatus: 'server_delivering',
                            createdAt: 1_000,
                            updatedAt: 1_000,
                            text: 'accepted provider-owned prompt',
                            rawRecord: { role: 'user', content: { type: 'text', text: 'accepted provider-owned prompt' } },
                        },
                        {
                            id: 'pending-local-local-1',
                            localId: 'local-1',
                            source: 'local_outbound',
                            createdAt: 1_000,
                            updatedAt: 1_000,
                            text: 'local optimistic duplicate',
                            rawRecord: { role: 'user', content: { type: 'text', text: 'local optimistic duplicate' } },
                        },
                    ],
                },
            },
        });

        domain.applyMessages('s1', [
            {
                id: 'm1',
                seq: 1,
                localId: 'local-1',
                createdAt: 2_000,
                isSidechain: false,
                role: 'user',
                content: { type: 'text', text: 'committed elsewhere' },
            } as any,
        ]);

        expect(get().sessionPending.s1.messages.map((message: any) => message.id)).toEqual(['pending-server-local-1']);
    });

    it('stores recovered chronology without retiring a matching optimistic pending row', () => {
        const { get, domain } = createHarness({
            sessions: {
                s1: { id: 's1', createdAt: 1, active: false, activeAt: 1, metadataVersion: 1, metadata: null },
            },
            sessionPending: {
                s1: {
                    isLoaded: true,
                    discarded: [],
                    messages: [{
                        id: 'pending-local-1', localId: 'local-1', source: 'local_outbound',
                        createdAt: 1_000, updatedAt: 1_000, text: 'live pending',
                        rawRecord: { role: 'user', content: { type: 'text', text: 'live pending' } },
                    }],
                },
            },
        });

        domain.applyMessages('s1', [{
            id: 'history-user', seq: 2, localId: 'local-1', createdAt: 9_000,
            sourceCreatedAt: 100, sourceUpdatedAt: 200,
            transcriptObservationProvenance: { kind: 'non_dependent', source: 'history' },
            isSidechain: false, role: 'user', content: { type: 'text', text: 'recovered' },
        } as any]);

        expect(get().sessionPending.s1.messages.map((message: any) => message.id)).toEqual(['pending-local-1']);
        const stored = Object.values(get().sessionMessages.s1.messagesById)[0] as any;
        expect(stored).toMatchObject({
            createdAt: 9_000,
            sourceCreatedAt: 100,
            sourceUpdatedAt: 200,
            transcriptObservationProvenance: { kind: 'non_dependent', source: 'history' },
        });
    });

    it('does not surface ready notification state from recovered history while a live ready event still does', () => {
        const { domain } = createHarness({
            sessions: {
                s1: { id: 's1', createdAt: 1, active: false, activeAt: 1, metadataVersion: 1, metadata: null },
            },
        });

        const recovered = domain.applyMessages('s1', [{
            id: 'history-ready', seq: 2, localId: null, createdAt: 2_000, sourceCreatedAt: 100,
            transcriptObservationProvenance: { kind: 'non_dependent', source: 'history' },
            isSidechain: false, role: 'event', content: { type: 'ready' },
        } as any]);
        const live = domain.applyMessages('s1', [{
            id: 'live-ready', seq: 3, localId: null, createdAt: 3_000,
            isSidechain: false, role: 'event', content: { type: 'ready' },
        } as any]);

        expect(recovered).toMatchObject({ changed: [], hasReadyEvent: false });
        expect(live).toMatchObject({ changed: [], hasReadyEvent: true, latestReadyEventSeq: 3 });
    });

    it('orders an agent-state permission placeholder by the matching transcript tool call once it arrives', () => {
        const { get, domain } = createHarness({
            sessions: {
                s1: {
                    id: 's1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    lastViewedSessionSeq: 1,
                    metadataVersion: 1,
                    agentStateVersion: 2,
                    metadata: null,
                    agentState: {
                        controlledByUser: null,
                        requests: {
                            ask1: {
                                tool: 'AskUserQuestion',
                                kind: 'user_action',
                                arguments: { questions: [{ question: 'Choose a path' }] },
                                createdAt: 1_000,
                            },
                        },
                        completedRequests: null,
                    },
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                    permissionMode: null,
                    permissionModeUpdatedAt: 0,
                },
            },
            sessionMessages: {
                s1: {
                    reducerState: undefined,
                    messageIdsOldestFirst: [],
                    messagesById: {},
                    messagesMap: {},
                    latestThinkingMessageId: null,
                    latestThinkingMessageActivityAtMs: null,
                    latestReadyEventSeq: null,
                    latestReadyEventAt: null,
                    messagesVersion: 0,
                    lastAppliedAgentStateVersion: 1,
                    isLoaded: true,
                },
            },
            sessionListRenderables: {},
        });

        domain.applyMessages('s1', []);

        const placeholderIds = get().sessionMessages.s1.messageIdsOldestFirst;
        expect(placeholderIds).toHaveLength(1);
        const placeholder = get().sessionMessages.s1.messagesById[placeholderIds[0]!] as any;
        expect(placeholder.kind).toBe('tool-call');
        expect(placeholder.seq).toBeUndefined();

        domain.applyMessages('s1', [
            {
                id: 'assistant-text',
                seq: 10,
                localId: null,
                createdAt: 2_000,
                isSidechain: false,
                role: 'agent',
                content: [{ type: 'text', text: 'Here is the rationale before the question.' }],
            } as any,
            {
                id: 'assistant-tool',
                seq: 11,
                localId: null,
                createdAt: 2_100,
                isSidechain: false,
                role: 'agent',
                content: [{
                    type: 'tool-call',
                    id: 'ask1',
                    name: 'AskUserQuestion',
                    input: { questions: [{ question: 'Choose a path' }] },
                    description: null,
                    uuid: 'tool-uuid',
                    parentUUID: null,
                }],
            } as any,
        ]);

        const messages = get().sessionMessages.s1.messageIdsOldestFirst
            .map((id: string) => get().sessionMessages.s1.messagesById[id]);

        expect(messages.map((message: any) => message.kind)).toEqual(['agent-text', 'tool-call']);
        expect((messages[0] as any).text).toBe('Here is the rationale before the question.');
        expect((messages[1] as any).tool.id).toBe('ask1');
        expect((messages[1] as any).seq).toBe(11);
    });

    it('orders blocks from the same transcript message by provider content order', () => {
        const { get, domain } = createHarness({
            sessions: {
                s1: {
                    id: 's1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    lastViewedSessionSeq: 1,
                    metadataVersion: 1,
                    agentStateVersion: 1,
                    metadata: null,
                    agentState: null,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                    permissionMode: null,
                    permissionModeUpdatedAt: 0,
                },
            },
            sessionMessages: {
                s1: {
                    reducerState: undefined,
                    messageIdsOldestFirst: [],
                    messagesById: {},
                    messagesMap: {},
                    latestThinkingMessageId: null,
                    latestThinkingMessageActivityAtMs: null,
                    latestReadyEventSeq: null,
                    latestReadyEventAt: null,
                    messagesVersion: 0,
                    lastAppliedAgentStateVersion: 1,
                    isLoaded: true,
                },
            },
            sessionListRenderables: {},
        });

        const randomSpy = vi.spyOn(Math, 'random')
            .mockReturnValueOnce(0.9)
            .mockReturnValueOnce(0.1);

        try {
            domain.applyMessages('s1', [
                {
                    id: 'assistant-message',
                    seq: 10,
                    localId: null,
                    createdAt: 2_000,
                    isSidechain: false,
                    role: 'agent',
                    content: [
                        {
                            type: 'text',
                            text: 'Text before the tool call.',
                            uuid: 'text-uuid',
                            parentUUID: null,
                        },
                        {
                            type: 'tool-call',
                            id: 'tool1',
                            name: 'AskUserQuestion',
                            input: { questions: [{ question: 'Choose a path' }] },
                            description: null,
                            uuid: 'tool-uuid',
                            parentUUID: null,
                        },
                    ],
                } as any,
            ]);
        } finally {
            randomSpy.mockRestore();
        }

        const messages = get().sessionMessages.s1.messageIdsOldestFirst
            .map((id: string) => get().sessionMessages.s1.messagesById[id]);

        expect(messages.map((message: any) => message.kind)).toEqual(['agent-text', 'tool-call']);
        expect((messages[0] as any).text).toBe('Text before the tool call.');
        expect((messages[1] as any).tool.id).toBe('tool1');
    });

    it('tracks latest thinking activity time only when a thinking message changes', () => {
        const { get, domain } = createHarness({
            sessions: {
                s1: {
                    id: 's1',
                    createdAt: 1,
                    active: false,
                    activeAt: 1,
                    metadataVersion: 1,
                    metadata: null,
                    permissionMode: null,
                    permissionModeUpdatedAt: 0,
                },
            },
        });

        const nowSpy = vi.spyOn(Date, 'now');

        nowSpy.mockReturnValue(1_000);
        domain.applyMessages('s1', [
            {
                id: 'think-1',
                seq: 1,
                localId: null,
                createdAt: 10,
                isSidechain: false,
                role: 'agent',
                content: [{ type: 'thinking', thinking: 'step 1', uuid: 'u1', parentUUID: null }],
            } as any,
        ]);

        const thinkingId = get().sessionMessages.s1.latestThinkingMessageId;
        expect(typeof thinkingId).toBe('string');
        expect(thinkingId).not.toHaveLength(0);
        const thinkingMessage = get().sessionMessages.s1.messagesById[thinkingId!] as any;
        expect(thinkingMessage?.kind).toBe('agent-text');
        expect(thinkingMessage?.isThinking).toBe(true);
        expect(get().sessionMessages.s1.latestThinkingMessageActivityAtMs).toBe(1_000);

        nowSpy.mockReturnValue(2_000);
        domain.applyMessages('s1', [
            {
                id: 'tool-1',
                seq: 2,
                localId: null,
                createdAt: 11,
                isSidechain: false,
                role: 'agent',
                content: [{
                    type: 'tool-call',
                    id: 'call-1',
                    name: 'Read',
                    input: { path: 'a.txt' },
                    description: null,
                    uuid: 't1',
                    parentUUID: null,
                }],
            } as any,
        ]);

        // Tool-only updates should not bump thinking activity.
        expect(get().sessionMessages.s1.latestThinkingMessageId).toBe(thinkingId);
        expect(get().sessionMessages.s1.latestThinkingMessageActivityAtMs).toBe(1_000);

        nowSpy.mockReturnValue(3_000);
        domain.applyMessages('s1', [
            {
                id: 'think-1',
                seq: 3,
                localId: null,
                createdAt: 10,
                isSidechain: false,
                role: 'agent',
                content: [{ type: 'thinking', thinking: 'step 1 (cont)', uuid: 'u1', parentUUID: null }],
            } as any,
        ]);

        expect(get().sessionMessages.s1.latestThinkingMessageId).toBe(thinkingId);
        expect(get().sessionMessages.s1.latestThinkingMessageActivityAtMs).toBe(3_000);

        nowSpy.mockRestore();
    });

    it('records applyMessages telemetry when sync performance telemetry is enabled', () => {
        const { domain } = createHarness({
            sessions: {
                s1: {
                    id: 's1',
                    createdAt: 1,
                    active: false,
                    activeAt: 1,
                    metadataVersion: 1,
                    metadata: null,
                    permissionMode: null,
                    permissionModeUpdatedAt: 0,
                },
            },
        });

        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        try {
            domain.applyMessages('s1', [
                {
                    id: 'm1',
                    seq: 1,
                    localId: null,
                    createdAt: 1000,
                    isSidechain: false,
                    role: 'user',
                    content: { type: 'text', text: 'first' },
                } as any,
                {
                    id: 'm2',
                    seq: 2,
                    localId: null,
                    createdAt: 1000,
                    isSidechain: false,
                    role: 'user',
                    content: { type: 'text', text: 'second' },
                } as any,
            ]);

            const event = syncPerformanceTelemetry
                .snapshot()
                .events.find((candidate) => candidate.name === 'sync.store.messages.apply');
            expect(event?.count).toBe(1);
            expect(event?.fields.messages).toBe(2);
            expect(event?.fields.processed).toBe(2);
            expect(event?.fields.changed).toBe(2);
            expect(event?.fields.uniqueInsertedOrMoved).toBe(2);
            expect(event?.fields.stateChanged).toBe(1);

            const reducerEvent = syncPerformanceTelemetry
                .snapshot()
                .events.find((candidate) => candidate.name === 'sync.store.messages.reducer');
            expect(reducerEvent?.count).toBe(1);
            expect(reducerEvent?.fields.messages).toBe(2);
            expect(reducerEvent?.fields.agentStateApplied).toBe(0);

            const indexEvent = syncPerformanceTelemetry
                .snapshot()
                .events.find((candidate) => candidate.name === 'sync.store.messages.index');
            expect(indexEvent?.count).toBe(1);
            expect(indexEvent?.fields.processed).toBe(2);
            expect(indexEvent?.fields.uniqueInsertedOrMoved).toBe(2);
        } finally {
            syncPerformanceTelemetry.configure({ enabled: false });
        }
    });

    it('uses append-only index work for higher-seq streaming messages', () => {
        const messageCount = 1_000;
        const existingIds = Array.from({ length: messageCount }, (_, index) => `m${index + 1}`);
        const messagesById = Object.fromEntries(existingIds.map((id, index) => [
            id,
            {
                id,
                kind: 'user-text',
                seq: index + 1,
                localId: null,
                createdAt: index + 1,
                text: `message ${index + 1}`,
            },
        ]));
        const { get, domain } = createHarness({
            sessions: {
                s1: {
                    id: 's1',
                    seq: messageCount,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    lastViewedSessionSeq: messageCount,
                    metadataVersion: 1,
                    agentStateVersion: 1,
                    metadata: null,
                    agentState: null,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                    permissionMode: null,
                    permissionModeUpdatedAt: 0,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                },
            },
            sessionMessages: {
                s1: {
                    reducerState: undefined,
                    messageIdsOldestFirst: existingIds,
                    messagesById,
                    messagesMap: messagesById,
                    latestThinkingMessageId: null,
                    latestThinkingMessageActivityAtMs: null,
                    messagesVersion: 1,
                    lastAppliedAgentStateVersion: 1,
                    isLoaded: true,
                },
            },
            sessionListRenderables: {
                s1: {
                    id: 's1',
                    seq: messageCount,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    lastViewedSessionSeq: messageCount,
                    metadataVersion: 1,
                    agentStateVersion: 1,
                    metadata: null,
                    thinking: false,
                    thinkingAt: 0,
                    presence: 'online',
                    hasPendingPermissionRequests: false,
                    hasPendingUserActionRequests: false,
                },
            },
        });

        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        try {
            domain.applyMessages('s1', [
                {
                    id: 'm1001',
                    seq: messageCount + 1,
                    localId: null,
                    createdAt: messageCount + 1,
                    isSidechain: false,
                    role: 'agent',
                    content: [{ type: 'text', text: 'next' }],
                } as any,
            ]);

            expect(get().sessionMessages.s1.messageIdsOldestFirst).toHaveLength(messageCount + 1);
            const indexEvent = syncPerformanceTelemetry
                .snapshot()
                .events.find((candidate) => candidate.name === 'sync.store.messages.index');
            expect(indexEvent?.fields.appendOnly).toBe(1);
        } finally {
            syncPerformanceTelemetry.configure({ enabled: false });
        }
    });

    it('keeps transcript store references stable for empty message updates without agent state', () => {
        const { get, domain } = createHarness({
            sessions: {
                s1: {
                    id: 's1',
                    createdAt: 1,
                    active: false,
                    activeAt: 1,
                    metadataVersion: 1,
                    metadata: null,
                    permissionMode: null,
                    permissionModeUpdatedAt: 0,
                    agentState: null,
                },
            },
        });

        domain.applyMessages('s1', [
            {
                id: 'm1',
                seq: 1,
                localId: null,
                createdAt: 1000,
                isSidechain: false,
                role: 'user',
                content: { type: 'text', text: 'first' },
            } as any,
        ]);

        const previousSessionMessages = get().sessionMessages;
        const previousEntry = previousSessionMessages.s1;
        const previousIds = previousEntry.messageIdsOldestFirst;
        const previousMessagesById = previousEntry.messagesById;
        const previousMessagesVersion = previousEntry.messagesVersion;
        const previousReducerVersion = previousEntry.reducerVersion;

        const result = domain.applyMessages('s1', []);

        expect(result).toEqual({ changed: [], hasReadyEvent: false });
        expect(get().sessionMessages).toBe(previousSessionMessages);
        expect(get().sessionMessages.s1).toBe(previousEntry);
        expect(get().sessionMessages.s1.messageIdsOldestFirst).toBe(previousIds);
        expect(get().sessionMessages.s1.messagesById).toBe(previousMessagesById);
        expect(get().sessionMessages.s1.messagesVersion).toBe(previousMessagesVersion);
        expect(get().sessionMessages.s1.reducerVersion).toBe(previousReducerVersion);
    });

    it('keeps transcript store references stable when an unchanged message is applied again', () => {
        const { get, domain } = createHarness({
            sessions: {
                s1: {
                    id: 's1',
                    createdAt: 1,
                    active: false,
                    activeAt: 1,
                    metadataVersion: 1,
                    metadata: null,
                    permissionMode: null,
                    permissionModeUpdatedAt: 0,
                    agentState: null,
                },
            },
        });

        const message = {
            id: 'm1',
            seq: 1,
            localId: null,
            createdAt: 1000,
            isSidechain: false,
            role: 'user',
            content: { type: 'text', text: 'first' },
        } as any;

        domain.applyMessages('s1', [message]);

        const previousSessionMessages = get().sessionMessages;
        const previousEntry = previousSessionMessages.s1;
        const previousIds = previousEntry.messageIdsOldestFirst;
        const previousMessagesById = previousEntry.messagesById;
        const previousMessagesVersion = previousEntry.messagesVersion;
        const previousReducerVersion = previousEntry.reducerVersion;

        const result = domain.applyMessages('s1', [message]);

        expect(result).toEqual({ changed: [], hasReadyEvent: false });
        expect(get().sessionMessages).toBe(previousSessionMessages);
        expect(get().sessionMessages.s1).toBe(previousEntry);
        expect(get().sessionMessages.s1.messageIdsOldestFirst).toBe(previousIds);
        expect(get().sessionMessages.s1.messagesById).toBe(previousMessagesById);
        expect(get().sessionMessages.s1.messagesVersion).toBe(previousMessagesVersion);
        expect(get().sessionMessages.s1.reducerVersion).toBe(previousReducerVersion);
    });

    it('advances subagent source version when an execution-run source message stops matching', () => {
        const { get, domain } = createHarness({
            sessions: {
                s1: {
                    id: 's1',
                    createdAt: 1,
                    active: false,
                    activeAt: 1,
                    metadataVersion: 1,
                    metadata: null,
                    permissionMode: null,
                    permissionModeUpdatedAt: 0,
                    agentState: null,
                },
            },
        });

        domain.applyMessages('s1', [
            {
                id: 'm1',
                seq: 1,
                localId: 'commit-1',
                createdAt: 1000,
                isSidechain: false,
                role: 'agent',
                content: [{ type: 'text', text: 'Execution run run_12345678 started', uuid: 'u1', parentUUID: null }],
                meta: buildStreamSegmentMeta(1_000),
            } as any,
        ]);

        expect(get().sessionMessages.s1.subagentSourceVersion).toBe(1);

        domain.applyMessages('s1', [
            {
                id: 'm2',
                seq: 2,
                localId: 'commit-2',
                createdAt: 1000,
                isSidechain: false,
                role: 'agent',
                content: [{ type: 'text', text: 'ordinary markdown token update', uuid: 'u1', parentUUID: null }],
                meta: buildStreamSegmentMeta(2_000),
            } as any,
        ]);

        expect(get().sessionMessages.s1.subagentSourceVersion).toBe(2);
    });

    it('keeps transcript store references stable for repeated empty updates after the same agent state version was applied', () => {
        const { get, domain } = createHarness({
            sessions: {
                s1: {
                    id: 's1',
                    createdAt: 1,
                    active: true,
                    activeAt: 1,
                    metadataVersion: 1,
                    metadata: null,
                    permissionMode: null,
                    permissionModeUpdatedAt: 0,
                    agentState: {
                        requests: {
                            req1: {
                                tool: 'Bash',
                                arguments: { command: 'ls' },
                                createdAt: 123,
                            },
                        },
                    },
                    agentStateVersion: 7,
                },
            },
        });

        const firstResult = domain.applyMessages('s1', []);
        expect(firstResult.changed.length).toBeGreaterThan(0);

        const previousSessionMessages = get().sessionMessages;
        const previousEntry = previousSessionMessages.s1;
        const previousIds = previousEntry.messageIdsOldestFirst;
        const previousMessagesById = previousEntry.messagesById;
        const previousMessagesVersion = previousEntry.messagesVersion;
        const previousReducerVersion = previousEntry.reducerVersion;

        const secondResult = domain.applyMessages('s1', []);

        expect(secondResult).toEqual({ changed: [], hasReadyEvent: false });
        expect(get().sessionMessages).toBe(previousSessionMessages);
        expect(get().sessionMessages.s1).toBe(previousEntry);
        expect(get().sessionMessages.s1.messageIdsOldestFirst).toBe(previousIds);
        expect(get().sessionMessages.s1.messagesById).toBe(previousMessagesById);
        expect(get().sessionMessages.s1.messagesVersion).toBe(previousMessagesVersion);
        expect(get().sessionMessages.s1.reducerVersion).toBe(previousReducerVersion);
    });

    it('renders recovered thinking and context-reset history without replacing live thinking or usage state', () => {
        const { get, domain } = createHarness({
            sessions: {
                s1: {
                    id: 's1', seq: 0, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
                    metadataVersion: 1, agentStateVersion: 1, metadata: null, agentState: null,
                    thinking: false, thinkingAt: 0, presence: 'online',
                },
            },
        });

        domain.applyMessages('s1', [{
            id: 'live-thinking', seq: 1, localId: null, createdAt: 1_000, isSidechain: false,
            role: 'agent',
            usage: { input_tokens: 5, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            content: [{ type: 'thinking', thinking: 'live', uuid: 'live-thinking', parentUUID: null }],
        } as any]);
        const liveThinkingId = get().sessionMessages.s1.latestThinkingMessageId;
        const liveThinkingActivityAt = get().sessionMessages.s1.latestThinkingMessageActivityAtMs;

        domain.applyMessages('s1', [
            {
                id: 'history-thinking', seq: 2, localId: null, createdAt: 9_000, sourceCreatedAt: 100,
                transcriptObservationProvenance: { kind: 'non_dependent', source: 'history' },
                isSidechain: false, role: 'agent',
                content: [{ type: 'thinking', thinking: 'old', uuid: 'history-thinking', parentUUID: null }],
            } as any,
            {
                id: 'history-reset', seq: 3, localId: null, createdAt: 10_000, sourceCreatedAt: 200,
                transcriptObservationProvenance: { kind: 'non_dependent', source: 'history' },
                isSidechain: false, role: 'event',
                content: { type: 'message', message: 'Context was reset' },
            } as any,
        ]);

        expect(get().sessionMessages.s1.messageIdsOldestFirst).toHaveLength(3);
        expect(get().sessionMessages.s1.latestThinkingMessageId).toBe(liveThinkingId);
        expect(get().sessionMessages.s1.latestThinkingMessageActivityAtMs).toBe(liveThinkingActivityAt);
        expect(get().sessions.s1.latestUsage).toMatchObject({ inputTokens: 5, outputTokens: 3 });
    });
});
