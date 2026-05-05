import { beforeEach, describe, expect, it, vi } from 'vitest';

import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { createMessagesDomain } from './messages';

function createHarness(initial: any) {
    let state: any = {
        sessions: {},
        sessionPending: {},
        sessionMessages: {},
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

beforeEach(() => {
    syncPerformanceTelemetry.configure({ enabled: false });
});

describe('messages domain: ordering', () => {
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
});
