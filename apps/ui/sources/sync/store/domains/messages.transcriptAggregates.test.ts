import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { ConcurrentSessionListCacheByServerId } from '../../domains/session/listing/concurrentSessionListCache';
import type { SessionListIndexItem } from '../../domains/sessionList/sessionListIndex';
import type { NormalizedMessage } from '../../typesRaw';
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

function agentTextMessage(
    id: string,
    createdAt: number,
    text: string,
    usage?: Record<string, number>,
): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt,
        isSidechain: false,
        role: 'agent',
        content: [{ type: 'text', text }],
        ...(usage ? { usage } : {}),
    } as unknown as NormalizedMessage;
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
        sessions: { s1: createSession() },
        sessionPending: {},
        sessionMessages: {},
        isMutableToolCall: () => false,
        applyMessages: () => ({ changed: [], hasReadyEvent: false }),
        replaceSessionMessages: () => ({ changed: [], hasReadyEvent: false }),
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

describe('messages domain: transcript renderable aggregates', () => {
    it('maintains one transcript aggregate incrementally across streaming applies', async () => {
        const { domain, get } = await createHarness();

        domain.applyMessages('s1', [agentTextMessage('a1', 2_100, 'hel')]);
        const firstAggregate = (get().sessionMessages.s1 as { renderableAggregate?: unknown }).renderableAggregate as {
            requestStates: Map<string, unknown>;
            latestCommittedMessageCreatedAt: number | null;
        };
        expect(firstAggregate).toBeDefined();
        const firstRequestStates = firstAggregate.requestStates;

        domain.applyMessages('s1', [agentTextMessage('a2', 2_200, 'lo world')]);
        const secondAggregate = (get().sessionMessages.s1 as { renderableAggregate?: unknown }).renderableAggregate as {
            requestStates: Map<string, unknown>;
            latestCommittedMessageCreatedAt: number | null;
        };

        // Aggregate reuse identity: no full rebuild on the streaming path.
        expect(secondAggregate).toBe(firstAggregate);
        expect(secondAggregate.requestStates).toBe(firstRequestStates);
        expect(secondAggregate.latestCommittedMessageCreatedAt).toBe(2_200);
    });

    it('derives the streamed renderable identically to the full-walk builder', async () => {
        const { domain, get } = await createHarness();

        domain.applyMessages('s1', [agentTextMessage('a1', 2_100, 'hel')]);
        domain.applyMessages('s1', [agentTextMessage('a2', 2_200, 'lo world')]);

        const { buildSessionListRenderableFromSession } = await import(
            '../../domains/session/listing/sessionListRenderable'
        );
        const sessionMessages = get().sessionMessages.s1;
        const messages = sessionMessages.messageIdsOldestFirst.map(
            (id: string) => sessionMessages.messagesById[id]!,
        );
        const groundTruth = buildSessionListRenderableFromSession(get().sessions.s1, undefined, messages);
        const streamed = get().sessionListRenderables.s1;

        expect(streamed.meaningfulActivityAt).toBe(groundTruth.meaningfulActivityAt);
        expect(streamed.hasPendingPermissionRequests).toBe(groundTruth.hasPendingPermissionRequests);
        expect(streamed.hasPendingUserActionRequests).toBe(groundTruth.hasPendingUserActionRequests);
        expect(streamed.pendingRequestObservedAt ?? null).toBe(groundTruth.pendingRequestObservedAt ?? null);
        expect(streamed.hasUnreadMessages === true).toBe(groundTruth.hasUnreadMessages === true);
    });

    it('mutates message revisions in place instead of copying the record per apply', async () => {
        const { domain, get } = await createHarness();

        domain.applyMessages('s1', [agentTextMessage('a1', 2_100, 'hel')]);
        const revisions = get().sessionMessages.s1.messageRevisionsById!;
        const firstStoredId = get().sessionMessages.s1.messageIdsOldestFirst[0]!;
        expect(revisions[firstStoredId]).toBe(1);

        domain.applyMessages('s1', [agentTextMessage('a2', 2_200, 'lo')]);
        const storedIds = get().sessionMessages.s1.messageIdsOldestFirst;
        expect(get().sessionMessages.s1.messageRevisionsById).toBe(revisions);
        expect(revisions[firstStoredId]).toBe(1);
        for (const storedId of storedIds) {
            expect(revisions[storedId]).toBeGreaterThanOrEqual(1);
        }
    });

    it('keeps the Session identity stable when usage and todos did not change', async () => {
        const { domain, get } = await createHarness();

        domain.applyMessages('s1', [agentTextMessage('a1', 2_100, 'hel', {
            input_tokens: 10,
            output_tokens: 5,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
        })]);
        const sessionAfterUsage = get().sessions.s1;
        expect(sessionAfterUsage.latestUsage).toMatchObject({ inputTokens: 10, outputTokens: 5 });

        // Usage-free streaming delta: nothing user-visible changed on the
        // Session object, so its identity must not churn.
        domain.applyMessages('s1', [agentTextMessage('a2', 2_200, 'lo')]);
        expect(get().sessions.s1).toBe(sessionAfterUsage);

        // A real usage change must still produce a fresh Session identity.
        domain.applyMessages('s1', [agentTextMessage('a3', 2_300, ' world', {
            input_tokens: 20,
            output_tokens: 9,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
        })]);
        expect(get().sessions.s1).not.toBe(sessionAfterUsage);
        expect(get().sessions.s1.latestUsage).toMatchObject({ inputTokens: 20, outputTokens: 9 });
    });
});
