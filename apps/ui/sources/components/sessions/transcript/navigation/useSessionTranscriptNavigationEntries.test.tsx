import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import type { Message } from '@/sync/domains/messages/messageTypes';
import type { SessionMessageHistoryRemoteRow } from '@/sync/engine/sessions/fetchUserMessageHistoryPage';
import { resetUserMessageHistoryRemoteEntriesForTests } from '@/hooks/session/useUserMessageHistory';

const persistedStorage = vi.hoisted(() => new Map<string, string>());

vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return persistedStorage.get(key);
        }

        set(key: string, value: string) {
            persistedStorage.set(key, value);
        }

        delete(key: string) {
            persistedStorage.delete(key);
        }

        getAllKeys() {
            return [...persistedStorage.keys()];
        }

        clearAll() {
            persistedStorage.clear();
        }
    }

    return { MMKV };
});

const transcriptState = vi.hoisted(() => ({
    ids: [] as string[],
    messagesById: {} as Record<string, unknown>,
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useForkedTranscriptSnapshot: () => null,
        useSessionTranscriptIds: () => ({ ids: transcriptState.ids, isLoaded: true }),
        useSessionMessagesById: () => transcriptState.messagesById,
        useSessionMessages: () => ({ messages: [], isLoaded: true }),
    });
});

vi.mock('@/sync/store/hooks', () => ({
    useActiveServerAccountScope: () => null,
}));

const fetchUserMessageHistoryPageMock = vi.hoisted(() => vi.fn());

// Only the transport is stubbed: the real shared remote-history record, its cache key and its
// in-flight cursor de-duplication stay in the path, because "one record, no double fetch" is
// exactly what these tests have to be able to falsify.
vi.mock('@/sync/sync', () => ({
    sync: {
        prefetchForkedTranscriptContext: async () => undefined,
        fetchUserMessageHistoryPage: (...args: unknown[]) => fetchUserMessageHistoryPageMock(...args),
    },
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
    usePreferredServerIdForSession: () => 'server-1',
}));

vi.mock('@/sync/domains/features/featureDecisionRuntime', () => ({
    useServerFeaturesSnapshotForServerId: () => ({
        status: 'ready',
        features: { capabilities: { session: { messages: { role: true } } } },
    }),
}));

function userMessage(id: string, seq: number, text: string): Message {
    return {
        id,
        localId: null,
        seq,
        createdAt: seq * 1000,
        kind: 'user-text',
        text,
        displayText: text,
    } as unknown as Message;
}

function agentMessage(id: string, seq: number, text: string): Message {
    return {
        id,
        localId: null,
        seq,
        createdAt: seq * 1000,
        kind: 'agent-text',
        text,
    } as unknown as Message;
}

function seedTranscript(messages: readonly Message[]) {
    transcriptState.ids = messages.map((message) => message.id);
    transcriptState.messagesById = Object.fromEntries(messages.map((message) => [message.id, message]));
}

function defaultTranscript(): Message[] {
    return [
        userMessage('m1', 1, 'Set up the project'),
        agentMessage('m2', 2, 'Project is ready'),
        userMessage('m3', 3, 'Run the tests'),
    ];
}

function remoteRow(seq: number, role: SessionMessageHistoryRemoteRow['role'], text: string): SessionMessageHistoryRemoteRow {
    return {
        messageId: `r${seq}`,
        routeMessageId: `server:r${seq}`,
        seq,
        createdAt: seq * 1000,
        role,
        text,
    };
}

function loadedPage(rows: readonly SessionMessageHistoryRemoteRow[], nextBeforeSeq: number | null) {
    return {
        status: 'loaded' as const,
        rows: [...rows],
        hasMore: nextBeforeSeq !== null,
        nextBeforeSeq,
    };
}

/** Effect -> fetch -> state -> effect chains need one flush per round trip. */
async function drainRemoteHistoryPaging(rounds = 20) {
    for (let round = 0; round < rounds; round += 1) {
        await flushHookEffects();
    }
}

describe('useSessionTranscriptNavigationEntries', () => {
    beforeEach(() => {
        standardCleanup();
        persistedStorage.clear();
        resetUserMessageHistoryRemoteEntriesForTests();
        fetchUserMessageHistoryPageMock.mockReset();
        fetchUserMessageHistoryPageMock.mockResolvedValue(loadedPage([], null));
        seedTranscript(defaultTranscript());
    });

    it('derives entries for a session with no transcript host mounted', async () => {
        const { useSessionTranscriptNavigationEntries } = await import('./useSessionTranscriptNavigationEntries');
        const rendered = await renderHook(() => useSessionTranscriptNavigationEntries('session-1'));

        const entries = rendered.getCurrent().transcriptNavigationEntries;
        expect(entries.map((entry) => entry.promptPreview)).toEqual([
            'Set up the project',
            'Run the tests',
        ]);
        expect(entries[0]?.responsePreview).toBe('Project is ready');
        expect(rendered.getCurrent().isLoaded).toBe(true);
    });

    it('refreshes entries when a pin is written through a writer that is not the navigation toggle', async () => {
        const { useSessionTranscriptNavigationEntries } = await import('./useSessionTranscriptNavigationEntries');
        const { savePersistedSessionMessagePins } = await import('@/sync/domains/state/sessionMessagePinsPersistence');
        const rendered = await renderHook(() => useSessionTranscriptNavigationEntries('session-1'));

        expect(rendered.getCurrent().transcriptNavigationEntries.some((entry) => entry.pinned)).toBe(false);

        await act(async () => {
            savePersistedSessionMessagePins('session-1', [{
                version: 1,
                sessionId: 'session-1',
                seq: 2,
                transcriptBlockIndex: null,
                routeMessageId: 'm2',
                role: 'assistant',
                pinnedAtMs: 5_000,
                label: null,
            }], null);
        });

        expect(rendered.getCurrent().transcriptNavigationEntries.some((entry) => entry.pinned)).toBe(true);
    });

    it('keeps entry identity stable for two concurrent consumers across re-renders', async () => {
        const { useSessionTranscriptNavigationEntries } = await import('./useSessionTranscriptNavigationEntries');
        const first = await renderHook(() => useSessionTranscriptNavigationEntries('session-1'));
        const second = await renderHook(() => useSessionTranscriptNavigationEntries('session-1'));
        await flushHookEffects();

        const firstEntries = first.getCurrent().transcriptNavigationEntries;
        const secondEntries = second.getCurrent().transcriptNavigationEntries;

        await first.rerender();
        await second.rerender();
        await first.rerender();

        // A shared single-slot derivation cache would be invalidated by the other
        // consumer's per-hook input identities and re-derive on every pass.
        expect(first.getCurrent().transcriptNavigationEntries).toBe(firstEntries);
        expect(second.getCurrent().transcriptNavigationEntries).toBe(secondEntries);
    });

    it('builds the timeline from server history when the session message store is empty', async () => {
        seedTranscript([]);
        fetchUserMessageHistoryPageMock.mockResolvedValue(loadedPage([
            remoteRow(4, 'assistant', 'Deployed to staging'),
            remoteRow(3, 'user', 'Deploy it'),
            remoteRow(2, 'assistant', 'Project is ready'),
            remoteRow(1, 'user', 'Set up the project'),
        ], null));

        const { useSessionTranscriptNavigationEntries } = await import('./useSessionTranscriptNavigationEntries');
        const rendered = await renderHook(() => useSessionTranscriptNavigationEntries('session-1'));
        await drainRemoteHistoryPaging(4);

        // No loaded row means no cursor: the newest page is a first-class request, not a reason
        // to fetch nothing.
        expect(fetchUserMessageHistoryPageMock).toHaveBeenCalledWith('session-1', { limit: 40 });
        const entries = rendered.getCurrent().transcriptNavigationEntries;
        expect(entries.map((entry) => entry.promptPreview)).toEqual([
            'Set up the project',
            'Deploy it',
        ]);
        expect(entries.map((entry) => entry.responsePreview)).toEqual([
            'Project is ready',
            'Deployed to staging',
        ]);
        expect(entries.every((entry) => entry.loaded === false)).toBe(true);
    });

    it('builds the timeline from server history when the loaded window holds only non-user rows', async () => {
        seedTranscript([agentMessage('m4', 4, 'Project is ready')]);
        fetchUserMessageHistoryPageMock.mockResolvedValue(loadedPage([
            remoteRow(3, 'user', 'Deploy it'),
            remoteRow(1, 'user', 'Set up the project'),
        ], null));

        const { useSessionTranscriptNavigationEntries } = await import('./useSessionTranscriptNavigationEntries');
        const rendered = await renderHook(() => useSessionTranscriptNavigationEntries('session-1'));
        await drainRemoteHistoryPaging(4);

        expect(fetchUserMessageHistoryPageMock).toHaveBeenCalledWith('session-1', { limit: 40, beforeSeq: 4 });
        expect(rendered.getCurrent().transcriptNavigationEntries.map((entry) => entry.promptPreview)).toEqual([
            'Set up the project',
            'Deploy it',
        ]);
    });

    it('keeps the transcript-host entry point on one bounded page for a settled window', async () => {
        fetchUserMessageHistoryPageMock.mockResolvedValue(loadedPage([
            remoteRow(0, 'user', 'Older prompt'),
        ], null));

        const { useSessionTranscriptNavigationEntriesFromMessages } = await import('./useSessionTranscriptNavigationEntries');
        const messages = defaultTranscript();
        const messagesById = Object.fromEntries(messages.map((message) => [message.id, message]));
        const messageIdsOldestFirst = messages.map((message) => message.id);
        const rendered = await renderHook(() => useSessionTranscriptNavigationEntriesFromMessages({
            activeServerAccountScope: null,
            forkedTranscriptEnabled: false,
            messageIdsOldestFirst,
            messagesById,
            sessionId: 'session-1',
        }));
        await drainRemoteHistoryPaging();

        expect(fetchUserMessageHistoryPageMock).toHaveBeenCalledTimes(1);
        expect(fetchUserMessageHistoryPageMock).toHaveBeenCalledWith('session-1', { limit: 40, beforeSeq: 1 });
        const entries = rendered.getCurrent().transcriptNavigationEntries;
        expect(entries.map((entry) => entry.promptPreview)).toEqual([
            'Older prompt',
            'Set up the project',
            'Run the tests',
        ]);
        expect(entries[1]?.responsePreview).toBe('Project is ready');
    });

    it('backfills a forked session from its own history instead of standing down entirely', async () => {
        fetchUserMessageHistoryPageMock.mockResolvedValue(loadedPage([
            remoteRow(0, 'user', 'Older prompt'),
        ], null));

        const { useSessionTranscriptNavigationEntriesFromMessages } = await import('./useSessionTranscriptNavigationEntries');
        const messages = defaultTranscript();
        const messagesById = Object.fromEntries(messages.map((message) => [message.id, message]));
        const messageIdsOldestFirst = messages.map((message) => message.id);
        const rendered = await renderHook(() => useSessionTranscriptNavigationEntriesFromMessages({
            activeServerAccountScope: null,
            forkedTranscriptEnabled: true,
            messageIdsOldestFirst,
            messagesById,
            sessionId: 'session-1',
        }));
        await drainRemoteHistoryPaging();

        // Asked for its own newest page — NOT a cursor read off the loaded rows, which for a fork
        // also contain read-only ancestor context numbered in a different session's seq space.
        expect(fetchUserMessageHistoryPageMock).toHaveBeenCalledWith('session-1', { limit: 40 });
        expect(rendered.getCurrent().transcriptNavigationEntries.map((entry) => entry.promptPreview)).toEqual([
            'Older prompt',
            'Set up the project',
            'Run the tests',
        ]);
    });

    it('stops paging at the bounded page cap', async () => {
        seedTranscript([]);
        let cursor = 1_000;
        fetchUserMessageHistoryPageMock.mockImplementation(async () => {
            cursor -= 1;
            // Agent-only pages never advance the prior-turn target, so only the page cap can stop this.
            return loadedPage([remoteRow(cursor, 'assistant', `agent ${cursor}`)], cursor);
        });

        const { useSessionTranscriptNavigationEntries } = await import('./useSessionTranscriptNavigationEntries');
        await renderHook(() => useSessionTranscriptNavigationEntries('session-1'));
        await drainRemoteHistoryPaging();

        expect(fetchUserMessageHistoryPageMock).toHaveBeenCalledTimes(12);
    });

    it('stops paging once the prior-turn target is reached', async () => {
        seedTranscript([]);
        fetchUserMessageHistoryPageMock.mockResolvedValue(loadedPage(
            Array.from({ length: 60 }, (_unused, index) => remoteRow(900 - index, 'user', `prompt ${index}`)),
            800,
        ));

        const { useSessionTranscriptNavigationEntries } = await import('./useSessionTranscriptNavigationEntries');
        await renderHook(() => useSessionTranscriptNavigationEntries('session-1'));
        await drainRemoteHistoryPaging();

        expect(fetchUserMessageHistoryPageMock).toHaveBeenCalledTimes(1);
    });

    it('serves two concurrently mounted consumers from one history request', async () => {
        seedTranscript([]);
        fetchUserMessageHistoryPageMock.mockResolvedValue(loadedPage([
            remoteRow(1, 'user', 'Set up the project'),
        ], null));

        const { useSessionTranscriptNavigationEntries } = await import('./useSessionTranscriptNavigationEntries');
        const first = await renderHook(() => useSessionTranscriptNavigationEntries('session-1'));
        const second = await renderHook(() => useSessionTranscriptNavigationEntries('session-1'));
        await drainRemoteHistoryPaging();

        expect(fetchUserMessageHistoryPageMock).toHaveBeenCalledTimes(1);
        expect(first.getCurrent().transcriptNavigationEntries.map((entry) => entry.promptPreview)).toEqual(['Set up the project']);
        expect(second.getCurrent().transcriptNavigationEntries.map((entry) => entry.promptPreview)).toEqual(['Set up the project']);
    });
});
