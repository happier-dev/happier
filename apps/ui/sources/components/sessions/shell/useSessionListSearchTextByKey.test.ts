import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { t } from '@/text';

import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Message } from "@happier-dev/session-core/messages";
import type { Session } from '@/sync/domains/state/storageTypes';
import type { StorageState } from '@/sync/store/types';
import { createReducer } from "@happier-dev/session-core/reducer";
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { buildSessionListIndexNodeId } from '@/sync/domains/sessionList/sessionListIndex';
import { workflowRunRowFromSummary } from '@/sync/store/domains/workflowRuns';
import { storage } from '@/sync/domains/state/storageStore';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { sessionTagKey } from './sessionTagUtils';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { getActiveServerId } from '@/sync/domains/server/serverProfiles';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { filterSessionListItemsForHeaderControls } from './sessionListFilters';

import {
    buildCanonicalSessionListSearchText,
    createSessionListSearchTextSelector,
    useSessionListSearchTextByKey,
} from './useSessionListSearchTextByKey';

// The third-party Markdown renderer is not used by the metadata-only search hook.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));

function createRenderable(
    overrides: Partial<SessionListRenderableSession> & Pick<SessionListRenderableSession, 'id'>,
): SessionListRenderableSession {
    return {
        seq: 0,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadataVersion: 1,
        agentStateVersion: 0,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 1,
        ...overrides,
    };
}

function createState(overrides: Partial<StorageState>): StorageState {
    return {
        sessions: {},
        sessionListRowsByServerId: {},
        ordinarySessionListMembershipByServerId: {},
        archivedSessionListMembershipByServerId: {},
        sessionMessages: {},
        sessionPending: {},
        ...overrides,
    } as StorageState;
}

describe('createSessionListSearchTextSelector', () => {
    it('indexes the canonical displayed title from the bounded list projection', () => {
        const session = createRenderable({
            id: 'session1',
            metadata: {
                name: 'Build lane',
                summaryText: 'Parser follow-up',
                path: '/workspace/project',
                host: 'builder',
                machineId: 'machine-a',
            },
        });

        expect(buildCanonicalSessionListSearchText({ sessionId: session.id, renderable: session }))
            .toBe('session1\nParser follow-up\n/workspace/project\nbuilder\nmachine-a');
    });

    it('indexes a no-folder session as a chat, never by its private folder', () => {
        const session = createRenderable({
            id: 'chat1',
            metadata: {
                name: 'Pricing questions',
                path: '/home/u/.happier/servers/s/session-directories/3f9a',
                host: 'builder',
                machineId: 'machine-a',
                sessionDirectoryV1: { v: 1, kind: 'managed' },
            },
        });

        const text = buildCanonicalSessionListSearchText({ sessionId: session.id, renderable: session });
        expect(text).not.toContain('session-directories');
        expect(text).toContain('Pricing questions');
        expect(text).toContain(t('session.folderless.chats'));
    });

    it('includes canonical tag and workspace display labels without reading transcript bodies', () => {
        const session = createRenderable({
            id: 'session1',
            metadata: {
                name: 'Build lane',
                summaryText: 'Bounded first-message title',
                path: '/workspace/project',
            },
        });

        expect(buildCanonicalSessionListSearchText({
            sessionId: session.id,
            renderable: session,
            tags: ['release', 'customer-visible'],
            workspaceDisplayLabel: 'Payments workspace',
        })).toBe([
            'session1',
            'Bounded first-message title',
            '/workspace/project',
            'release',
            'customer-visible',
            'Payments workspace',
        ].join('\n'));
    });

    it('projects exact server-qualified organization metadata into the contextual haystack', () => {
        const selector = createSessionListSearchTextSelector([
            { type: 'session', sessionId: 'session1', serverId: 'server1', serverName: undefined },
        ], true, {
            sessionTags: { [sessionTagKey('server1', 'session1')]: ['release'] },
            workspaceRefs: [{
                id: 'workspace-ref-1',
                serverId: 'server1',
                machineId: 'machine-a',
                rootPath: '/workspace/project',
                label: 'Payments workspace',
                createdAtMs: 1,
                lastOpenedAtMs: null,
            }],
        });
        const result = selector(createState({
            sessionListRowsByServerId: {
                server1: {
                    session1: createRenderable({
                        id: 'session1',
                        metadata: { machineId: 'machine-a', path: '/workspace/project' },
                    }),
                },
            },
        }));

        expect(result[sessionTagKey('server1', 'session1')]).toContain('release');
        expect(result[sessionTagKey('server1', 'session1')]).toContain('Payments workspace');
    });

    it('does not read same-id metadata from another Home through the bare-id Session store', () => {
        const selector = createSessionListSearchTextSelector([
            { type: 'session', sessionId: 'same-session', serverId: 'home-a', serverName: undefined },
        ], true);
        const otherHomeSession = {
            ...createRenderable({
                id: 'same-session',
                metadata: { name: 'Home B private title', path: '/home-b/repo' },
            }),
            metadataLayoutVersion: 0,
            agentState: null,
        } as Session;
        const result = selector(createState({
            sessions: { 'same-session': otherHomeSession },
            sessionListRowsByServerId: {
                'home-a': {
                    'same-session': createRenderable({
                        id: 'same-session',
                        metadata: { name: 'Home A title', path: '/home-a/repo' },
                    }),
                },
            },
        }));

        expect(result[sessionTagKey('home-a', 'same-session')]).toContain('Home A title');
        expect(result[sessionTagKey('home-a', 'same-session')]).not.toContain('Home B private title');
    });

    it('reuses cached text without reading 1260 rows on an empty session-list delta tick', () => {
        let metadataReads = 0;
        // Matches the Account A row census observed during SESSION-SEARCH-1110.
        const rows = Array.from({ length: 1260 }, (_, index) => {
            const row = createRenderable({ id: `session${index + 1}` });
            Object.defineProperty(row, 'metadata', {
                configurable: true,
                enumerable: true,
                get: () => {
                    metadataReads += 1;
                    return { name: 'Build lane', path: '/repo' };
                },
            });
            return row;
        });
        const sessionListRowsByServerId = { server1: Object.fromEntries(rows.map((row) => [row.id, row])) };
        const selector = createSessionListSearchTextSelector(rows.map((row) => ({
            type: 'session', sessionId: row.id, serverId: 'server1',
        })), true);

        const first = selector(createState({
            sessionListRenderableDelta: {
                revision: 1,
                changedSessionIds: ['session1'],
                removedSessionIds: [],
                rebuiltSessionListIndex: true,
            },
            sessionListRowsByServerId,
        }));
        const readsAfterFirstSelection = metadataReads;

        const second = selector(createState({
            sessionListRenderableDelta: {
                revision: 2,
                changedSessionIds: [],
                removedSessionIds: [],
                rebuiltSessionListIndex: false,
            },
            sessionListRowsByServerId,
        }));

        expect(second).toBe(first);
        expect(second[sessionTagKey('server1', 'session1')]).toContain('Build lane');
        expect(metadataReads).toBe(readsAfterFirstSelection);
    });

    it('returns the same result when the store asks for the same snapshot again', () => {
        const selector = createSessionListSearchTextSelector([
            { type: 'session', sessionId: 'session1', serverId: 'server1', serverName: undefined },
        ], true);
        const state = createState({
            sessionListRowsByServerId: {
                server1: {
                    session1: createRenderable({
                        id: 'session1',
                        metadata: { name: 'Build lane', path: '/repo' },
                    }),
                },
            },
        });

        const first = selector(state);
        const second = selector(state);

        expect(second).toBe(first);
    });

    it('the canonical builder indexes private layout-v1 workspace fields from the owner view, not shared metadata', () => {
        const session: Session = {
            id: 'session1',
            seq: 0,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            presence: 1,
            metadataLayoutVersion: 1,
            metadata: {
                host: '',
                path: '/must-not-index',
                summary: {
                    text: 'Shared title',
                    updatedAt: 1,
                },
            },
            ownerMetadataView: {
                name: 'Private session',
                path: '/private/repo',
                host: 'private-host',
                machineId: 'private-machine',
            },
        };
        const result = buildCanonicalSessionListSearchText({ sessionId: 'session1', session });

        expect(result).toContain('/private/repo');
        expect(result).not.toContain('/must-not-index');
    });

    it('does not index hydrated transcript or tool-call text into the immediate local haystack', () => {
        const messages: Message[] = [
            {
                id: 'message-1',
                kind: 'user-text',
                localId: null,
                createdAt: 1,
                text: 'hydrated-transcript-only-term',
            },
            {
                id: 'message-2',
                kind: 'tool-call',
                localId: null,
                createdAt: 2,
                children: [],
                tool: {
                    name: 'shell',
                    state: 'running',
                    input: {},
                    createdAt: 2,
                    startedAt: 2,
                    completedAt: null,
                    description: 'tool-description-only-term',
                },
            },
        ];
        const messagesById = Object.fromEntries(messages.map((message) => [message.id, message]));
        const selector = createSessionListSearchTextSelector([
            { type: 'session', sessionId: 'session1', serverId: 'server1', serverName: undefined },
        ], true);
        const result = selector(createState({
            sessionListRowsByServerId: {
                server1: { session1: createRenderable({
                    id: 'session1',
                    metadata: { name: 'Canonical metadata title', path: '/workspace/project' },
                }) },
            },
            sessionMessages: {
                session1: {
                    messageIdsOldestFirst: messages.map((message) => message.id),
                    messagesById,
                    messagesMap: messagesById,
                    reducerState: createReducer(),
                    latestThinkingMessageId: null,
                    latestThinkingMessageActivityAtMs: null,
                    messagesVersion: 1,
                    isLoaded: true,
                },
            },
        }));

        expect(result[sessionTagKey('server1', 'session1')]).toContain('Canonical metadata title');
        expect(result[sessionTagKey('server1', 'session1')]).not.toContain('hydrated-transcript-only-term');
        expect(result[sessionTagKey('server1', 'session1')]).not.toContain('tool-description-only-term');
    });

    it('does not index pending or discarded message text into the immediate local haystack', () => {
        const selector = createSessionListSearchTextSelector([
            { type: 'session', sessionId: 'session1', serverId: 'server1', serverName: undefined },
        ], true);
        const result = selector(createState({
            sessionListRowsByServerId: {
                server1: { session1: createRenderable({ id: 'session1', metadata: { name: 'Metadata only', path: '' } }) },
            },
            sessionPending: {
                session1: {
                    isLoaded: true,
                    messages: [{
                        id: 'pending-1',
                        localId: null,
                        createdAt: 1,
                        updatedAt: 1,
                        text: 'pending-only-term',
                        rawRecord: {},
                    }],
                    discarded: [{
                        id: 'discarded-1',
                        localId: null,
                        createdAt: 1,
                        updatedAt: 1,
                        text: 'discarded-only-term',
                        rawRecord: {},
                        discardedAt: 2,
                        discardedReason: 'manual',
                    }],
                },
            },
        }));

        expect(result[sessionTagKey('server1', 'session1')]).toContain('Metadata only');
        expect(result[sessionTagKey('server1', 'session1')]).not.toContain('pending-only-term');
        expect(result[sessionTagKey('server1', 'session1')]).not.toContain('discarded-only-term');
    });
});

describe('mixed Session and Run search projection', () => {
    const previousState = storage.getState();
    afterEach(() => {
        standardCleanup();
        storage.setState(previousState);
    });

    it('finds the visible title after transcript and saved-title arrivals without remounting search', async () => {
        const serverId = getActiveServerId();
        const session = createSessionFixture({ id: 'late-title-search', serverId,
            metadata: { path: '/tmp', host: 'builder' } });
        act(() => storage.getState().applySessions([session]));
        const items = [{ type: 'session', serverId, sessionId: session.id }] as const;
        const hook = await renderHook(() => useSessionListSearchTextByKey(items, true));
        const matches = (query: string) => filterSessionListItemsForHeaderControls(items, {
            searchQuery: query, selectedTagIds: { include: [], exclude: [] }, ...hook.getCurrent(),
        });
        expect(matches('qa-agents-1110-kilo')).toHaveLength(0);
        act(() => { storage.getState().applyMessages(session.id, [{
            id: 'first-prompt', role: 'user', localId: null, createdAt: 1, seq: 2, isSidechain: false,
            content: { type: 'text', text: 'qa-agents-1110-kilo' },
        }]); });
        const row = storage.getState().sessionListRowsByServerId[serverId]![session.id]!;
        expect(getSessionName(row, serverId)).toBe('qa-agents-1110-kilo');
        expect(hook.getCurrent().primarySearchableTextBySessionKey[sessionTagKey(serverId, session.id)]?.split('\n'))
            .toContain(getSessionName(row, serverId));
        expect(matches('qa-agents-1110-kilo')).toEqual(items);
        act(() => storage.getState().applySessions([{ ...session, metadataVersion: 2,
            metadata: { ...session.metadata!, summary: { text: 'Saved kilo title', updatedAt: 2 } } }]));
        expect(matches('Saved kilo title')).toEqual(items);
        expect(matches('qa-agents-1110-kilo')).toHaveLength(0);
    });

    it('indexes visible Run private title and Where under its qualified node id without reading detail', async () => {
        const row = {
            ...workflowRunRowFromSummary(createWorkflowRunSummaryFixture({
                id: 'same-id', startedBy: 'user', where: { machineId: 'builder', directory: '/payments/repo' },
            })),
            metadata: { kind: 'available', value: { title: 'Prepare release', description: 'Review payments' } } as const,
        };
        Object.defineProperty(row, 'detail', { get: () => { throw new Error('search must not read Run detail'); } });
        storage.setState({
            profileScope: { serverId: 'home-a', accountId: 'account-a' },
            workflowRunsById: { 'same-id': row },
            sessionListRowsByServerId: { 'home-a': { 'same-id': createRenderable({
                id: 'same-id', metadata: { name: 'Session title', path: '/session/repo' },
            }) } },
        });
        const run = { type: 'workflow_run', serverId: 'home-a', runId: 'same-id' } as const;
        const hook = await renderHook(() => useSessionListSearchTextByKey([
            { type: 'session', serverId: 'home-a', sessionId: 'same-id' }, run,
            { type: 'workflow_run', serverId: 'home-b', runId: 'same-id' },
        ], true));
        expect(hook.getCurrent()).toMatchObject({
            searchableTextBySessionKey: { [sessionTagKey('home-a', 'same-id')]: expect.stringContaining('Session title') },
            searchableTextByWorkflowRunKey: { [buildSessionListIndexNodeId(run)]: expect.stringContaining('Prepare release') },
        });
        expect(hook.getCurrent().searchableTextByWorkflowRunKey[buildSessionListIndexNodeId(run)]).toContain('/payments/repo');
        expect(hook.getCurrent().searchableTextByWorkflowRunKey[buildSessionListIndexNodeId(run)]).toContain('builder');
        expect(Object.keys(hook.getCurrent().searchableTextByWorkflowRunKey)).toEqual([buildSessionListIndexNodeId(run)]);
    });

    it('refreshes a Run-only title change on an empty Session delta and preserves unchanged haystacks', async () => {
        const run = { type: 'workflow_run', serverId: 'home-a', runId: 'run-1' } as const;
        const row = { ...workflowRunRowFromSummary(createWorkflowRunSummaryFixture()),
            metadata: { kind: 'available', value: { title: 'Before' } } as const };
        storage.setState({ profileScope: { serverId: 'home-a', accountId: 'account-a' }, workflowRunsById: { 'run-1': row },
            sessionListRenderableDelta: { revision: 1, changedSessionIds: [], removedSessionIds: [], rebuiltSessionListIndex: false } });
        const items = [run];
        const hook = await renderHook(() => useSessionListSearchTextByKey(items, true));
        const first = hook.getCurrent().searchableTextByWorkflowRunKey;
        act(() => { storage.setState({ workflowRunsById: { 'run-1': { ...row,
            metadata: { kind: 'available', value: { title: 'After' } } } },
            sessionListRenderableDelta: { revision: 2, changedSessionIds: [], removedSessionIds: [], rebuiltSessionListIndex: false } }); });
        expect(hook.getCurrent().searchableTextByWorkflowRunKey[buildSessionListIndexNodeId(run)]).toContain('After');
        expect(hook.getCurrent().searchableTextByWorkflowRunKey).not.toBe(first);
        const updated = hook.getCurrent().searchableTextByWorkflowRunKey;
        act(() => { storage.setState({ workflowRunsById: { ...storage.getState().workflowRunsById,
            unrelated: workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: 'unrelated' })) } }); });
        expect(hook.getCurrent().searchableTextByWorkflowRunKey).toBe(updated);
    });

    it('keeps unavailable private metadata out and clears Run search when the Account scope retires', async () => {
        const run = { type: 'workflow_run', serverId: 'home-a', runId: 'run-1' } as const;
        storage.setState({ profileScope: { serverId: 'home-a', accountId: 'account-a' }, workflowRunsById: {
            'run-1': { ...workflowRunRowFromSummary(createWorkflowRunSummaryFixture()), metadata: { kind: 'unavailable', reason: 'content_unavailable' } },
        } });
        const items = [run];
        const hook = await renderHook(() => useSessionListSearchTextByKey(items, true));
        expect(hook.getCurrent()).toMatchObject({ searchableTextByWorkflowRunKey: {
            [buildSessionListIndexNodeId(run)]: 'run-1',
        } });
        act(() => { storage.setState({ profileScope: null }); });
        expect(hook.getCurrent()).toMatchObject({ searchableTextByWorkflowRunKey: {} });
    });
});
