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

describe('messages domain: isMutableToolCall', () => {
    it('treats read-only and container tools as not mutable and unknown tools as mutable', () => {
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

        domain.applyMessages('s1', [
            {
                id: 'msg_tool_read',
                seq: 1,
                localId: null,
                createdAt: 1100,
                role: 'agent',
                isSidechain: false,
                content: [
                    {
                        type: 'tool-call',
                        id: 'call_read',
                        name: 'Read',
                        input: { path: 'a.txt' },
                        description: null,
                        uuid: 'uuid_read',
                        parentUUID: null,
                    },
                ],
            } as any,
            {
                id: 'msg_tool_ls',
                seq: 2,
                localId: null,
                createdAt: 1150,
                role: 'agent',
                isSidechain: false,
                content: [
                    {
                        type: 'tool-call',
                        id: 'call_ls',
                        name: 'LS',
                        input: { path: '.' },
                        description: null,
                        uuid: 'uuid_ls',
                        parentUUID: null,
                    },
                ],
            } as any,
            {
                id: 'msg_tool_task',
                seq: 3,
                localId: null,
                createdAt: 1175,
                role: 'agent',
                isSidechain: false,
                content: [
                    {
                        type: 'tool-call',
                        id: 'call_task',
                        name: 'Task',
                        input: { description: 'delegate without direct file mutations' },
                        description: null,
                        uuid: 'uuid_task',
                        parentUUID: null,
                    },
                ],
            } as any,
            {
                id: 'msg_tool_unknown',
                seq: 4,
                localId: null,
                createdAt: 1200,
                role: 'agent',
                isSidechain: false,
                content: [
                    {
                        type: 'tool-call',
                        id: 'call_unknown',
                        name: 'SomeUnknownTool',
                        input: {},
                        description: null,
                        uuid: 'uuid_unknown',
                        parentUUID: null,
                    },
                ],
            } as any,
        ]);

        expect(domain.isMutableToolCall('s1', 'call_read')).toBe(false);
        expect(domain.isMutableToolCall('s1', 'call_ls')).toBe(false);
        expect(domain.isMutableToolCall('s1', 'call_task')).toBe(false);
        expect(domain.isMutableToolCall('s1', 'call_unknown')).toBe(true);
    });
});
