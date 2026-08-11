import { describe, expect, it } from 'vitest';

import { createMessagesDomain } from './messages';

const MINUTE_MS = 60_000;

function createHarness(session: Readonly<{ active: boolean; activeAt: number }>) {
    let state: any = {
        sessions: {
            s1: {
                id: 's1',
                createdAt: 1,
                metadataVersion: 1,
                metadata: null,
                permissionMode: null,
                permissionModeUpdatedAt: 0,
                ...session,
            },
        },
        sessionPending: {},
        sessionMessages: {},
    };

    const get = () => state;
    const set = (updater: any) => {
        const next = typeof updater === 'function' ? updater(state) : updater;
        state = { ...state, ...next };
    };

    const domain = createMessagesDomain({ get, set } as any);
    return { get, domain };
}

function applySubagentWithSidechain(domain: any, createdAt: number) {
    domain.applyMessages('s1', [
        {
            id: 'msg_subagent',
            seq: 1,
            localId: null,
            createdAt,
            role: 'agent',
            isSidechain: false,
            content: [
                {
                    type: 'tool-call',
                    id: 'tool_subagent_1',
                    name: 'Task',
                    input: { prompt: 'Search for files' },
                    description: null,
                    uuid: 'uuid_subagent',
                    parentUUID: null,
                },
            ],
        } as any,
        {
            id: 'msg_sc_text',
            seq: 2,
            localId: null,
            createdAt: createdAt + 1,
            role: 'agent',
            isSidechain: true,
            sidechainId: 'tool_subagent_1',
            content: [
                {
                    type: 'text',
                    text: 'Still working',
                    uuid: 'uuid_sc_text',
                    parentUUID: null,
                },
            ],
        } as any,
    ]);
}

function readSubagentToolState(state: any): string | undefined {
    const sessionMessages = state.sessionMessages.s1;
    const ids: string[] = sessionMessages?.messageIdsOldestFirst ?? [];
    const message = ids
        .map((id) => sessionMessages?.messagesById[id])
        .find((m: any) => m?.kind === 'tool-call' && m.tool?.name === 'Task') as any;
    return message?.tool?.state;
}

describe('messages domain: subagent rows on a session whose process is gone', () => {
    it('closes a subagent row whose sidechain spoke once the owning session process is long gone', () => {
        const activeAt = Date.now() - 30 * MINUTE_MS;
        const { get, domain } = createHarness({ active: false, activeAt });

        applySubagentWithSidechain(domain, activeAt - MINUTE_MS);

        expect(readSubagentToolState(get())).toBe('unavailable');
    });

    it('keeps a subagent row running while the owning session process is still attached', () => {
        const { get, domain } = createHarness({ active: true, activeAt: Date.now() });

        applySubagentWithSidechain(domain, Date.now() - MINUTE_MS);

        expect(readSubagentToolState(get())).toBe('running');
    });

    it('keeps a subagent row running through a brief detachment rather than reading it as death', () => {
        const activeAt = Date.now() - 5_000;
        const { get, domain } = createHarness({ active: false, activeAt });

        applySubagentWithSidechain(domain, activeAt - MINUTE_MS);

        expect(readSubagentToolState(get())).toBe('running');
    });
});
