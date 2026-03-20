import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
        sessionRepositoryTreeExpandedPathsBySessionId: {},
        reviewCommentsDraftsBySessionId: {},
        actionDraftsBySessionId: {},
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

describe('sessions domain: thinking grace', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-02-05T00:00:00.000Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('keeps thinkingGraceUntil briefly after thinking turns off (prevents UI flicker)', async () => {
        vi.doMock('../../runtime/orchestration/projectManager', () => ({
            projectManager: {
                updateSessions: vi.fn(),
            },
        }));

        const { createReducer } = await import('../../reducer/reducer');
        const { createSessionsDomain } = await import('./sessions');
        const { get, domain } = createHarness(createSessionsDomain, createReducer);

        const t0 = Date.now();

        domain.applySessions([
            {
                id: 's1',
                seq: 0,
                createdAt: t0,
                updatedAt: t0,
                active: true,
                activeAt: t0,
                metadata: null,
                metadataVersion: 0,
                agentState: null,
                agentStateVersion: 1,
                thinking: true,
                thinkingAt: t0,
                presence: 'online',
            } as any,
        ]);

        const graceUntil = get().sessions.s1?.thinkingGraceUntil ?? null;
        expect(typeof graceUntil).toBe('number');
        expect(graceUntil).toBeGreaterThan(t0);

        vi.advanceTimersByTime(250);

        const t1 = Date.now();
        domain.applySessions([
            {
                id: 's1',
                seq: 0,
                createdAt: t0,
                updatedAt: t1,
                active: true,
                activeAt: t1,
                metadata: null,
                metadataVersion: 0,
                agentState: null,
                agentStateVersion: 1,
                thinking: false,
                thinkingAt: t1,
                presence: 'online',
            } as any,
        ]);

        // Grace remains in place after thinking turns off.
        expect(get().sessions.s1?.thinkingGraceUntil ?? null).toBe(graceUntil);

        // Once the grace timer expires, the marker clears without polling.
        const remainingMs = Math.max(0, (graceUntil as number) - Date.now());
        vi.advanceTimersByTime(remainingMs + 1);

        expect(get().sessions.s1?.thinkingGraceUntil ?? null).toBeNull();
    });
});

