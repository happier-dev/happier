import { describe, expect, it, vi } from 'vitest';

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
});
