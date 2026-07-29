import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import type { Message } from '@/sync/domains/messages/messageTypes';

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

vi.mock('@/sync/sync', () => ({
    sync: {
        prefetchForkedTranscriptContext: async () => undefined,
    },
}));

vi.mock('@/hooks/session/useUserMessageHistory', () => ({
    useUserMessageHistoryRemoteEntries: () => ({
        rows: [],
        hasMore: false,
        nextBeforeSeq: null,
        pagesLoaded: 0,
        pendingEncryption: false,
        requestNextPage: () => {},
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

function seedTranscript() {
    const messages = [
        userMessage('m1', 1, 'Set up the project'),
        agentMessage('m2', 2, 'Project is ready'),
        userMessage('m3', 3, 'Run the tests'),
    ];
    transcriptState.ids = messages.map((message) => message.id);
    transcriptState.messagesById = Object.fromEntries(messages.map((message) => [message.id, message]));
}

describe('useSessionTranscriptNavigationEntries', () => {
    beforeEach(() => {
        standardCleanup();
        persistedStorage.clear();
        seedTranscript();
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
});
