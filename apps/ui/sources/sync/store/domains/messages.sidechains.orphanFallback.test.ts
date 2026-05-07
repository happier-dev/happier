import { describe, expect, it } from 'vitest';

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

function readRootToolNames(state: any, sessionId: string): string[] {
    const sessionMessages = state.sessionMessages[sessionId];
    const ids = sessionMessages?.messageIdsOldestFirst ?? [];
    return ids
        .map((id: string) => sessionMessages?.messagesById[id])
        .filter((m: any) => m?.kind === 'tool-call')
        .map((m: any) => m.tool?.name);
}

describe('messages domain: sidechains (orphan fallback)', () => {
    it('keeps orphan sidechain children out of the root transcript until the owning tool-call arrives', () => {
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
                id: 'msg_sc_root',
                seq: 1,
                localId: null,
                createdAt: 1100,
                role: 'agent',
                isSidechain: true,
                sidechainId: 'tool_task_1',
                content: [
                    {
                        type: 'sidechain',
                        uuid: 'uuid_sc_root',
                        prompt: 'Search for files',
                    },
                ],
            } as any,
            {
                id: 'msg_sc_tool',
                seq: 2,
                localId: null,
                createdAt: 1200,
                role: 'agent',
                isSidechain: true,
                sidechainId: 'tool_task_1',
                content: [
                    {
                        type: 'tool-call',
                        id: 'call_inner_1',
                        name: 'Read',
                        input: { path: 'a.txt' },
                        description: null,
                        uuid: 'uuid_sc_tool',
                        parentUUID: 'uuid_sc_root',
                    },
                ],
            } as any,
        ]);

        expect(readRootToolNames(get(), 's1')).toEqual([]);

        // Now the parent tool-call arrives.
        domain.applyMessages('s1', [
            {
                id: 'msg_task',
                seq: 3,
                localId: null,
                createdAt: 1300,
                role: 'agent',
                isSidechain: false,
                content: [
                    {
                        type: 'tool-call',
                        id: 'tool_task_1',
                        name: 'Task',
                        input: { prompt: 'Search for files' },
                        description: null,
                        uuid: 'uuid_task',
                        parentUUID: null,
                    },
                ],
            } as any,
        ]);

        const ids2 = get().sessionMessages.s1.messageIdsOldestFirst as string[];
        const rootToolNames2 = readRootToolNames(get(), 's1');

        // Once the owning tool-call exists, sidechain children must no longer appear as root transcript items.
        expect(rootToolNames2).toContain('Task');
        expect(rootToolNames2).not.toContain('Read');

        const taskMessage = ids2
            .map((id) => get().sessionMessages.s1.messagesById[id])
            .find((m: any) => m?.kind === 'tool-call' && m.tool?.name === 'Task') as any;
        expect(taskMessage).toBeTruthy();
        expect(Array.isArray(taskMessage.children)).toBe(true);
        expect(taskMessage.children.some((c: any) => c.kind === 'tool-call' && c.tool?.name === 'Read')).toBe(true);
    });
});
