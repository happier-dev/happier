import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { invokeTestInstanceHandler, renderScreen, standardCleanup } from '@/dev/testkit';
import { installNavigationCommonModuleMocks } from '@/components/ui/navigation/navigationTestHelpers';
import type { Message } from '@/sync/domains/messages/messageTypes';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

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
    isLoaded: true,
}));

installNavigationCommonModuleMocks({
    typography: async () => ({
        Typography: {
            default: () => ({}),
            tabular: () => ({}),
        },
    }),
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            FlatList: ({ data, renderItem, keyExtractor, ...rest }: any) => React.createElement(
                'FlatList',
                { ...rest, data },
                (data ?? []).map((item: any, index: number) => React.createElement(
                    React.Fragment,
                    { key: keyExtractor ? keyExtractor(item, index) : String(index) },
                    renderItem?.({ item, index }),
                )),
            ),
        });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useForkedTranscriptSnapshot: () => null,
            useSessionTranscriptIds: () => ({ ids: transcriptState.ids, isLoaded: transcriptState.isLoaded }),
            useSessionMessagesById: () => transcriptState.messagesById,
            useSessionMessages: () => ({ messages: [], isLoaded: transcriptState.isLoaded }),
        });
    },
});

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/sync/store/hooks', () => ({ useActiveServerAccountScope: () => null }));
vi.mock('@/sync/sync', () => ({ sync: { prefetchForkedTranscriptContext: async () => undefined } }));
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

const ENTRY_TEST_ID = 'nav-entry:session-1:user-turn:3';

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

function seedTranscript() {
    const messages = [
        userMessage('m1', 1, 'Set up the project'),
        userMessage('m3', 3, 'Run the tests'),
    ];
    transcriptState.ids = messages.map((message) => message.id);
    transcriptState.messagesById = Object.fromEntries(messages.map((message) => [message.id, message]));
    transcriptState.isLoaded = true;
}

async function flushDeferredJump() {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

describe('SessionTranscriptNavigationPane', () => {
    beforeEach(async () => {
        standardCleanup();
        persistedStorage.clear();
        seedTranscript();
        const { transcriptNavigationPaneStore } = await import('@/components/sessions/transcript/navigation/transcriptNavigationPaneStore');
        transcriptNavigationPaneStore.set('session-1', null);
        const { clearTranscriptNavigationVisibilityStore } = await import('@/components/sessions/transcript/viewport/visibility/transcriptNavigationVisibilityStore');
        clearTranscriptNavigationVisibilityStore('session-1');
    });

    it('renders the session timeline with no transcript host mounted for the session', async () => {
        const { SessionTranscriptNavigationPane } = await import('./SessionTranscriptNavigationPane');
        const screen = await renderScreen(
            <SessionTranscriptNavigationPane sessionId="session-1" testIDPrefix="nav" />,
        );

        expect(screen.findByTestId('nav-pane')).toBeTruthy();
        expect(screen.findByTestId(ENTRY_TEST_ID)).toBeTruthy();
        expect(screen.getTextContent()).toContain('Set up the project');
        expect(screen.getTextContent()).toContain('Run the tests');
    });

    it('marks the reader position from the session visibility store rather than a host payload', async () => {
        const { SessionTranscriptNavigationPane } = await import('./SessionTranscriptNavigationPane');
        const { getTranscriptNavigationVisibilityStore } = await import('@/components/sessions/transcript/viewport/visibility/transcriptNavigationVisibilityStore');
        const screen = await renderScreen(
            <SessionTranscriptNavigationPane sessionId="session-1" testIDPrefix="nav" />,
        );

        expect(screen.findByTestId('nav-node-current:session-1:user-turn:3')).toBeNull();

        await act(async () => {
            getTranscriptNavigationVisibilityStore('session-1').set({
                currentAnchorId: 'session-1:user-turn:3',
                visibleAnchorIds: ['session-1:user-turn:3'],
            });
        });

        expect(screen.findByTestId('nav-node-current:session-1:user-turn:3')).toBeTruthy();
    });

    it('reveals the transcript BEFORE the jump and lands on the handler the revealed host republishes', async () => {
        const { SessionTranscriptNavigationPane } = await import('./SessionTranscriptNavigationPane');
        const { transcriptNavigationPaneStore } = await import('@/components/sessions/transcript/navigation/transcriptNavigationPaneStore');

        const order: string[] = [];
        const jumpedEntries: Array<{ id: string; seq: number | null }> = [];
        const onRevealTranscript = vi.fn(() => {
            order.push('reveal');
        });
        const onEntryPress = vi.fn((entry: { id: string; seq: number | null }) => {
            order.push('jump');
            jumpedEntries.push(entry);
            return { status: 'scrolled' as const };
        });

        const screen = await renderScreen(
            <SessionTranscriptNavigationPane
                sessionId="session-1"
                onRevealTranscript={onRevealTranscript}
                testIDPrefix="nav"
            />,
        );

        // The mobile right-panel route case: the transcript screen is a different route, so
        // React tore the host's layout effect down and no jump handler is registered.
        await screen.pressByTestIdAsync(ENTRY_TEST_ID);

        expect(onRevealTranscript).toHaveBeenCalledTimes(1);
        expect(onEntryPress).not.toHaveBeenCalled();

        await act(async () => {
            transcriptNavigationPaneStore.set('session-1', { onEntryPress });
        });
        await flushDeferredJump();

        expect(onEntryPress).toHaveBeenCalledTimes(1);
        expect(jumpedEntries[0]).toMatchObject({ id: 'session-1:user-turn:3', seq: 3 });
        expect(order).toEqual(['reveal', 'jump']);
    });

    it('never jumps into a still-hidden scene: an already-registered handler still waits for the reveal to commit', async () => {
        const { SessionTranscriptNavigationPane } = await import('./SessionTranscriptNavigationPane');
        const { transcriptNavigationPaneStore } = await import('@/components/sessions/transcript/navigation/transcriptNavigationPaneStore');
        const onEntryPress = vi.fn(() => ({ status: 'scrolled' as const }));
        transcriptNavigationPaneStore.set('session-1', { onEntryPress });

        const screen = await renderScreen(
            <SessionTranscriptNavigationPane
                sessionId="session-1"
                onRevealTranscript={() => {}}
                testIDPrefix="nav"
            />,
        );

        await screen.pressByTestIdAsync(ENTRY_TEST_ID);
        expect(onEntryPress).not.toHaveBeenCalled();

        await flushDeferredJump();
        expect(onEntryPress).toHaveBeenCalledTimes(1);
    });

    it('jumps straight through the registered handler when the transcript is already visible beside the pane', async () => {
        const { SessionTranscriptNavigationPane } = await import('./SessionTranscriptNavigationPane');
        const { transcriptNavigationPaneStore } = await import('@/components/sessions/transcript/navigation/transcriptNavigationPaneStore');
        const onEntryPress = vi.fn(() => ({ status: 'scrolled' as const }));
        transcriptNavigationPaneStore.set('session-1', { onEntryPress });

        const screen = await renderScreen(
            <SessionTranscriptNavigationPane sessionId="session-1" testIDPrefix="nav" />,
        );

        await screen.pressByTestIdAsync(ENTRY_TEST_ID);

        expect(onEntryPress).toHaveBeenCalledTimes(1);
    });

    it('exits through the close affordance and through Escape', async () => {
        const { SessionTranscriptNavigationPane } = await import('./SessionTranscriptNavigationPane');
        const onRequestClose = vi.fn();
        const screen = await renderScreen(
            <SessionTranscriptNavigationPane
                sessionId="session-1"
                onRequestClose={onRequestClose}
                testIDPrefix="nav"
            />,
        );

        await screen.pressByTestIdAsync('nav-close');
        expect(onRequestClose).toHaveBeenCalledTimes(1);

        invokeTestInstanceHandler(screen.findByTestId('nav-entry-list'), 'onKeyDown', {
            nativeEvent: { key: 'Escape' },
            preventDefault: () => {},
        });
        expect(onRequestClose).toHaveBeenCalledTimes(2);
    });
});
