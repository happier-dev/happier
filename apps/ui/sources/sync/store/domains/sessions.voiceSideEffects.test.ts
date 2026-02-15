import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
});

function createHarness(createSessionsDomain: any, createReducer: any) {
    let state: any = {
        sessions: {},
        sessionsData: null,
        sessionListViewData: null,
        sessionListViewDataByServerId: {},
        sessionScmStatus: {},
        sessionLastViewed: {},
        isDataReady: false,
        machines: {},
        sessionMessages: {
            s1: {
                messages: [],
                messagesMap: {},
                reducerState: createReducer(),
                isLoaded: true,
            },
        },
        settings: { groupInactiveSessionsByProject: false },
    };

    const get = () => state;
    const set = (updater: any) => {
        const next = typeof updater === 'function' ? updater(state) : updater;
        state = { ...state, ...next };
    };

    const domain = createSessionsDomain({ get, set } as any);
    return { get, domain };
}

describe('sessions domain: no voice side effects', () => {
    it('does not send voice messages when agentState updates arrive via applySessions', async () => {
        const sendTextMessage = vi.fn();
        vi.doMock('../../runtime/orchestration/projectManager', () => ({
            projectManager: {
                updateSessions: vi.fn(),
            },
        }));

        const { createReducer } = await import('../../reducer/reducer');
        const { createSessionsDomain } = await import('./sessions');
        const { domain } = createHarness(createSessionsDomain, createReducer);

        domain.applySessions([
            {
                id: 's1',
                seq: 0,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                metadata: null,
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 1,
            } as any,
        ]);

        domain.applySessions([
            {
                id: 's1',
                seq: 0,
                createdAt: 1,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                metadata: null,
                metadataVersion: 1,
                agentState: {
                    requests: {
                        req1: {
                            tool: 'Bash',
                            arguments: { command: 'ls' },
                            createdAt: 123,
                        },
                    },
                },
                agentStateVersion: 1,
                thinking: false,
                thinkingAt: 0,
                presence: 2,
            } as any,
        ]);

        expect(sendTextMessage).not.toHaveBeenCalled();
    });
});
