import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { ConcurrentSessionListCacheByServerId } from '../../domains/session/listing/concurrentSessionListCache';
import type { SessionListIndexItem } from '../../domains/sessionList/sessionListIndex';
import type { Session } from '../../domains/state/storageTypes';
import type { StoreGet, StoreSet } from './_shared';
import type { MessagesDomain } from './messages';
import type { SessionPending } from './pending';

type HarnessState = MessagesDomain & {
    sessions: Record<string, Session>;
    sessionPending: Record<string, SessionPending>;
    sessionListRenderables: Record<string, SessionListRenderableSession>;
    sessionListRowStateByServerId: Readonly<Record<string, Readonly<Record<string, SessionListRenderableSession>>>>;
    sessionListIndexByServerId: Readonly<Record<string, SessionListIndexItem[] | null | undefined>>;
    concurrentSessionListCacheByServerId: ConcurrentSessionListCacheByServerId;
    machines: Record<string, never>;
    machineDisplayById: Record<string, never>;
    profile: { id?: string | null } | null;
    settings: {
        groupInactiveSessionsByProject?: boolean;
        sessionListActiveGroupingV1?: 'project' | 'date';
        sessionListInactiveGroupingV1?: 'project' | 'date';
        sessionListSectionModeV1?: 'activity' | 'single';
    };
    getProjectForSession?: (sessionId: string) => null;
};

function createSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 's1',
        serverId: 'server_1',
        seq: 10,
        createdAt: 1_000,
        updatedAt: 2_000,
        active: true,
        activeAt: 2_000,
        archivedAt: null,
        lastViewedSessionSeq: 10,
        metadata: {
            machineId: 'm1',
            path: '/home/u/repo',
            homeDir: '/home/u',
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        latestTurnStatus: 'in_progress',
        latestTurnStatusObservedAt: 2_000,
        permissionMode: null,
        permissionModeUpdatedAt: 0,
        ...overrides,
    } as Session;
}

function createRenderable(overrides: Partial<SessionListRenderableSession> = {}): SessionListRenderableSession {
    return {
        id: 's1',
        seq: 10,
        createdAt: 1_000,
        updatedAt: 2_000,
        active: true,
        activeAt: 2_000,
        archivedAt: null,
        lastViewedSessionSeq: 10,
        metadata: {
            machineId: 'm1',
            path: '/home/u/repo',
            homeDir: '/home/u',
        },
        metadataVersion: 1,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        latestTurnStatus: 'in_progress',
        latestTurnStatusObservedAt: 2_000,
        hasPendingPermissionRequests: false,
        hasPendingUserActionRequests: false,
        pendingRequestObservedAt: null,
        hasUnreadMessages: false,
        keepVisibleWhenInactive: false,
        ...overrides,
    };
}

async function createHarness() {
    vi.doMock('../../domains/server/serverRuntime', () => ({
        getActiveServerSnapshot: vi.fn(() => ({
            serverId: 'server_1',
            serverUrl: 'http://server.test',
            generation: 1,
        })),
    }));

    const { createMessagesDomain } = await import('./messages');
    const renderable = createRenderable();
    let state: HarnessState = {
        sessions: {
            s1: createSession({
                agentState: {
                    controlledByUser: null,
                    requests: {
                        req_1: {
                            tool: 'Bash',
                            kind: 'permission',
                            arguments: { command: 'pwd' },
                            createdAt: 2_100,
                        },
                    },
                    completedRequests: null,
                },
                agentStateVersion: 2,
            }),
        },
        sessionPending: {},
        sessionMessages: {},
        isMutableToolCall: () => false,
        applyMessages: () => ({ changed: [], hasReadyEvent: false }),
        applyMessagesLoaded: () => {},
        evictSessionMessages: () => {},
        resetSessionMessages: () => {},
        sessionListRenderables: { s1: renderable },
        sessionListRowStateByServerId: { server_1: { s1: renderable } },
        sessionListIndexByServerId: { server_1: null },
        concurrentSessionListCacheByServerId: {},
        machines: {},
        machineDisplayById: {},
        profile: null,
        settings: {
            groupInactiveSessionsByProject: false,
            sessionListActiveGroupingV1: 'project',
            sessionListInactiveGroupingV1: 'date',
            sessionListSectionModeV1: 'activity',
        },
    };

    const get: StoreGet<HarnessState> = () => state;
    const set: StoreSet<HarnessState> = (updater, replace) => {
        const next = typeof updater === 'function' ? updater(state) : updater;
        state = replace ? (next as HarnessState) : { ...state, ...next };
    };
    const domain = createMessagesDomain({ get, set });
    state = { ...state, ...domain };
    return { domain, get };
}

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useRealTimers();
});

describe('messages domain: session list finalization', () => {
    it('updates server-scoped row state when agent-state messages do not advance the session seq', async () => {
        const { domain, get } = await createHarness();

        expect(get().sessionListRowStateByServerId.server_1?.s1?.hasPendingPermissionRequests).toBe(false);

        domain.applyMessages('s1', []);

        expect(get().sessionListRenderables.s1?.hasPendingPermissionRequests).toBe(true);
        expect(get().sessionListRenderables.s1?.pendingRequestObservedAt).toBe(2_100);
        expect(get().sessionListRowStateByServerId.server_1?.s1?.hasPendingPermissionRequests).toBe(true);
        expect(get().sessionListRowStateByServerId.server_1?.s1?.pendingRequestObservedAt).toBe(2_100);
    });
});
