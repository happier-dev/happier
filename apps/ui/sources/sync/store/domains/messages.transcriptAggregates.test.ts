import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { ConcurrentSessionListCacheByServerId } from '../../domains/session/listing/concurrentSessionListCache';
import type { SessionListIndexItem } from '../../domains/sessionList/sessionListIndex';
import type { NormalizedMessage } from "@happier-dev/session-core/raw";
import type { Session } from '../../domains/state/storageTypes';
import type { StoreGet, StoreSet } from './_shared';
import type { MessagesDomain } from './messages';
import type { SessionPending } from './pending';
import type { SessionListRenderableDelta } from './sessionListIndexFinalization';

type HarnessState = MessagesDomain & {
    sessions: Record<string, Session>;
    sessionPending: Record<string, SessionPending>;
    sessionListRenderableDelta: SessionListRenderableDelta;
    sessionListRowsByServerId: Readonly<Record<string, Readonly<Record<string, SessionListRenderableSession>>>>;
    ordinarySessionListMembershipByServerId: Readonly<Record<string, readonly string[] | undefined>>;
    sessionListIndexByServerId: Readonly<Record<string, SessionListIndexItem[] | null | undefined>>;
    concurrentSessionListCacheByServerId: ConcurrentSessionListCacheByServerId;
    machines: Record<string, never>;
    machineDisplayById: Record<string, never>;
    profile: { id?: string | null } | null;
    settings: {
        sessionListLayoutV1?: 'projects' | 'recent_activity';
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
    let state: HarnessState;
    const get: StoreGet<HarnessState> = () => state;
    const set: StoreSet<HarnessState> = (updater, replace) => {
        const next = typeof updater === 'function' ? updater(state) : updater;
        state = replace ? (next as HarnessState) : { ...state, ...next };
    };
    const domain = createMessagesDomain<HarnessState>({ get, set });
    state = {
        ...domain,
        sessions: { s1: createSession() },
        sessionPending: {},
        sessionListRenderableDelta: { revision: 0, changedSessionIds: [], removedSessionIds: [], rebuiltSessionListIndex: false },
        sessionListRowsByServerId: { server_1: { s1: renderable } },
        ordinarySessionListMembershipByServerId: { server_1: ['s1'] },
        sessionListIndexByServerId: { server_1: null },
        concurrentSessionListCacheByServerId: {},
        machines: {},
        machineDisplayById: {},
        profile: null,
        settings: {
            sessionListLayoutV1: 'projects',
        },
    };

    return { domain, get };
}

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useRealTimers();
});

describe('messages domain: transcript renderable aggregates', () => {
    it.each(['empty', 'unchanged'] as const)('admits a missing WorkerUpdate projection on an %s owner update', async kind => {
        const { domain, get } = await createHarness();
        const notice: NormalizedMessage = { id: 'retained-update', seq: 20, localId: null, createdAt: 20,
            role: 'event', isSidechain: false, content: { type: 'worker-update', update: {
                v: 1, workerKind: 'session', workerId: 'worker', ownerState: 'settled', wake: 'finished',
                headline: 'Retained result', canInspect: true,
            } } };
        domain.applyMessages('s1', [notice]);
        // An already-materialized transcript from before this optional internal projection existed.
        get().sessionMessages.s1 = { ...get().sessionMessages.s1, latestWorkerUpdates: undefined };
        domain.applyMessages('s1', kind === 'empty' ? [] : [notice]);
        expect(get().sessionMessages.s1.latestWorkerUpdates?.session?.worker).toMatchObject({ headline: 'Retained result' });
        const admitted = get().sessionMessages.s1.latestWorkerUpdates;
        domain.applyMessages('s1', []);
        expect(get().sessionMessages.s1.latestWorkerUpdates).toBe(admitted);
    });

    it('projects latest WorkerUpdates incrementally and retires them with their transcript', async () => {
        const { domain, get } = await createHarness();
        const notice = (id: string, seq: number, headline: string, ownerState: 'settled' | 'failed' = 'settled'): NormalizedMessage => ({
            id, seq, localId: null, createdAt: seq, role: 'event', isSidechain: false,
            content: { type: 'worker-update', update: { v: 1, workerKind: 'session', workerId: 'worker',
                ownerState, wake: ownerState === 'failed' ? 'needs_you' : 'finished', headline, canInspect: true } },
        });
        domain.applyMessages('s1', [notice('latest-update', 20, 'Latest result')]);
        const projection = get().sessionMessages.s1.latestWorkerUpdates;
        expect(get().sessionMessages.s1.messagesById[projection!.latestMessage!.messageId]).toMatchObject({
            event: { type: 'worker-update', update: { headline: 'Latest result' } },
        });
        expect(projection?.session?.worker).toMatchObject({ headline: 'Latest result',
            workerKind: 'session', workerId: 'worker', ownerState: 'settled', wake: 'finished' });
        domain.applyMessages('s1', [notice('older-update', 10, 'Older result')]);
        expect(get().sessionMessages.s1.latestWorkerUpdates).toBe(projection);
        domain.applyMessages('s1', Array.from({ length: 1_000 }, (_, index) =>
            agentTextMessage(`text-${index}`, index + 100, 'Streaming content')));
        expect(get().sessionMessages.s1.latestWorkerUpdates).toBe(projection);
        // Recap follows the latest delivered notice across worker kinds, never ordinary text.
        domain.applyMessages('s1', [{ id: 'run-result', seq: 21, localId: null, createdAt: 1,
            role: 'event', isSidechain: false, content: { type: 'worker-update', update: {
                v: 1, workerKind: 'execution_run', workerId: 'run', ownerState: 'succeeded', wake: 'finished',
                headline: 'Background result', result: 'Delivered body', canInspect: true,
            } } }]);
        const runMessageId = get().sessionMessages.s1.latestWorkerUpdates!.latestMessage!.messageId;
        expect(get().sessionMessages.s1.messagesById[runMessageId]).toMatchObject({
            event: { type: 'worker-update', update: { workerKind: 'execution_run', result: 'Delivered body' } },
        });
        expect(get().sessionMessages.s1.latestWorkerUpdates?.session?.worker).toBe(projection?.session?.worker);
        // Another outcome is a new native occurrence; replaying one event id cannot rewrite its content.
        domain.applyMessages('s1', [notice('failed-outcome', 25, 'Latest result', 'failed')]);
        expect(get().sessionMessages.s1.latestWorkerUpdates?.session?.worker).toMatchObject({
            headline: 'Latest result', ownerState: 'failed', wake: 'needs_you',
        });
        const failedOutcome = get().sessionMessages.s1.latestWorkerUpdates;
        expect(get().sessionMessages.s1.messagesById[failedOutcome!.latestMessage!.messageId]).toMatchObject({
            event: { type: 'worker-update', update: { ownerState: 'failed' } },
        });
        domain.applyMessages('s1', [notice('failed-outcome', 25, 'Latest result', 'failed')]);
        expect(get().sessionMessages.s1.latestWorkerUpdates).toBe(failedOutcome);
        domain.applyMessages('s1', [notice('next-update', 30, 'New result')]);
        expect(get().sessionMessages.s1.latestWorkerUpdates?.session?.worker).toMatchObject({ headline: 'New result' });
        domain.replaceSessionMessages('s1', [notice('older-update', 10, 'Older result'),
            { id: 'next-update', seq: 30, localId: null, createdAt: 30, role: 'event', isSidechain: false,
                content: { type: 'ready' } }]);
        expect(get().sessionMessages.s1.latestWorkerUpdates?.session?.worker).toMatchObject({ headline: 'Older result' });
        const replacementMessageId = get().sessionMessages.s1.latestWorkerUpdates!.latestMessage!.messageId;
        expect(get().sessionMessages.s1.messagesById[replacementMessageId]).toMatchObject({
            event: { type: 'worker-update', update: { headline: 'Older result' } },
        });
        domain.replaceSessionMessages('s1', [{ id: 'older-update', seq: 10, localId: null, createdAt: 10,
            role: 'event', isSidechain: false, content: { type: 'ready' } }]);
        expect(get().sessionMessages.s1.latestWorkerUpdates?.session?.worker).toBeUndefined();
        domain.replaceSessionMessages('s1', [notice('replacement', 5, 'Replacement history')]);
        expect(get().sessionMessages.s1.latestWorkerUpdates?.session?.worker).toMatchObject({ headline: 'Replacement history' });
        domain.resetSessionMessages('s1');
        expect(get().sessionMessages.s1.latestWorkerUpdates?.session?.worker).toBeUndefined();
        expect(get().sessionMessages.s1.latestWorkerUpdates?.latestMessage).toBeNull();
        domain.applyMessages('s1', [notice('reopened', 40, 'Reopened result')]);
        expect(get().sessionMessages.s1.latestWorkerUpdates?.session?.worker).toMatchObject({ headline: 'Reopened result' });
        domain.evictSessionMessages('s1');
        expect(get().sessionMessages.s1).toBeUndefined();
    });

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
        const streamed = get().sessionListRowsByServerId.server_1?.s1;

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
