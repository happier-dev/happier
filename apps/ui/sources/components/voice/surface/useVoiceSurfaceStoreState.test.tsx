import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';

import { createSessionFixture, createSessionMessagesFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storage';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { observeStorageSubscriptionDeliveries } from '@/dev/testkit/performance/storageSubscriptionCensus';

import { useVoiceSurfaceStoreState } from './useVoiceSurfaceStoreState';

const initialStorageState = getStorage().getState();
const initialBindingState = voiceSessionBindingStore.getState();

describe('useVoiceSurfaceStoreState', () => {
    it('moves Session demand with its target and releases it when absent', async () => {
        const storage = getStorage();
        storage.setState({ sessions: {
            first: createSessionFixture({ id: 'first' }), second: createSessionFixture({ id: 'second' }),
        } });
        const delivery = observeStorageSubscriptionDeliveries();
        const initialProps: { sessionId: string | null } = { sessionId: 'first' };
        const hook = await renderHook(({ sessionId }: { sessionId: string | null }) => useVoiceSurfaceStoreState({
            activeControlSessionId: sessionId, providerId: 'local_conversation', surfaceSessionId: sessionId,
            transcriptEnabled: false, voiceSettings: {}, voicePrivacy: { shareFilePaths: true, shareSessionSummary: true },
        }), { initialProps });
        const write = async (sessionId: string, seq: number) => act(async () => {
            storage.setState(state => ({ sessions: { ...state.sessions, [sessionId]: { ...state.sessions[sessionId]!, seq } } }));
        });
        try {
            await hook.rerender({ sessionId: 'second' });
            delivery.reset();
            await write('first', 10);
            expect(delivery.count).toBe(0);
            await write('second', 20);
            expect(delivery.count).toBeGreaterThan(0);
            expect(hook.getCurrent().activeControlSession?.seq).toBe(20);
            expect(hook.getCurrent().currentSession?.seq).toBe(20);
            await hook.rerender({ sessionId: null });
            delivery.reset();
            await write('second', 30);
            expect(delivery.count).toBe(0);
            expect(hook.getCurrent().currentSession).toBeNull();
            expect(hook.getCurrent().activeControlSession).toBeNull();
        } finally {
            await hook.unmount();
            delivery.restore();
        }
    });

    it.each([true, false])('delivers only demanded Session and transcript changes (transcript enabled: %s)', async (transcriptEnabled) => {
        const storage = getStorage();
        storage.setState({ sessions: { surface: createSessionFixture({ id: 'surface', serverId: 'server-active' }) } });
        const delivery = observeStorageSubscriptionDeliveries();
        const hook = await renderHook(() => useVoiceSurfaceStoreState({
            activeControlSessionId: null, providerId: 'local_conversation', surfaceSessionId: 'surface',
            transcriptEnabled, voiceSettings: {}, voicePrivacy: { shareFilePaths: true, shareSessionSummary: true },
        }));
        try {
            delivery.reset();
            for (let index = 0; index < 5; index++) await act(async () => {
                storage.setState(state => ({
                    sessions: { ...state.sessions, unrelated: createSessionFixture({ id: 'unrelated', seq: index }) },
                    sessionMessages: { ...state.sessionMessages, unrelated: createSessionMessagesFixture() },
                }));
            });
            expect(delivery.count).toBe(0);
            await act(async () => { storage.setState(state => ({ sessions: {
                ...state.sessions, surface: { ...state.sessions.surface!, seq: 42 },
            } })); });
            expect(delivery.count).toBeGreaterThan(0);
            expect(hook.getCurrent().currentSession?.seq).toBe(42);
        } finally {
            await hook.unmount();
            delivery.restore();
        }
    });

    beforeEach(() => {
        getStorage().setState(initialStorageState, true);
        voiceSessionBindingStore.setState(initialBindingState, true);
    });

    afterEach(() => {
        standardCleanup();
        getStorage().setState(initialStorageState, true);
        voiceSessionBindingStore.setState(initialBindingState, true);
    });

    it('opens the hidden conversation when the surface session id is already the canonical conversation session id', async () => {
        const storage = getStorage();
        voiceSessionBindingStore.getState().bind({
            adapterId: 'local_conversation',
            controlSessionId: 'voice-control-1',
            conversationSessionId: 'voice-conversation-1',
            conversationSessionAddress: { serverId: 'server-active', sessionId: 'voice-conversation-1' },
            targetSessionAddress: { serverId: 'server-active', sessionId: 'target-session-1' },
            transcriptMode: 'native_session',
            updatedAt: 10,
        });
        storage.setState((state) => ({
            ...state,
            isDataReady: true,
            sessions: {
                ...state.sessions,
                'voice-conversation-1': createSessionFixture({
                    id: 'voice-conversation-1',
                    serverId: 'server-active',
                    metadata: {
                        path: '/tmp/voice-conversation-1',
                        host: 'localhost',
                    },
                    presence: 'online',
                }),
            },
            sessionMessages: {
                ...state.sessionMessages,
                'voice-conversation-1': createSessionMessagesFixture({
                    messageIdsOldestFirst: ['m1'],
                    messagesById: {
                        m1: {
                            id: 'm1', localId: 'm1',
                            kind: 'agent-text',
                            text: 'Hidden conversation reply',
                            createdAt: 5,
                        },
                    },
                }),
            },
        }));

        const hook = await renderHook(() =>
            useVoiceSurfaceStoreState({
                activeControlSessionId: null,
                providerId: 'local_conversation',
                surfaceSessionId: 'voice-conversation-1',
                transcriptEnabled: true,
                voiceSettings: { providerId: 'local_conversation' },
                voicePrivacy: {
                    shareFilePaths: true,
                    shareSessionSummary: true,
                },
            }),
        );

        expect(hook.getCurrent().openConversationSessionId).toBe('voice-conversation-1');
        expect(hook.getCurrent().transcriptEntries).toEqual([
            {
                id: 'm1',
                createdAt: 5,
                kind: 'assistant',
                text: 'Hidden conversation reply',
                transcriptState: 'final',
                announce: false,
                announcementId: 'voice-persisted:m1',
            },
        ]);

        await hook.unmount();
    });

    it('reads only the requested surface session from storage state', async () => {
        const storage = getStorage();
        storage.setState((state) => ({
            ...state,
            isDataReady: true,
            sessions: {
                ...state.sessions,
                'surface-session-1': createSessionFixture({
                    id: 'surface-session-1',
                    metadata: {
                        path: '/repo', host: 'test', summaryText: 'Surface session',
                    },
                    presence: 'online',
                }),
                'other-session': createSessionFixture({
                    id: 'other-session',
                    metadata: {
                        path: '/repo', host: 'test', summaryText: 'Unrelated session',
                    },
                    presence: 'online',
                }),
            },
        }));

        const hook = await renderHook(() =>
            useVoiceSurfaceStoreState({
                activeControlSessionId: null,
                providerId: 'local_conversation',
                surfaceSessionId: 'surface-session-1',
                transcriptEnabled: true,
                voiceSettings: { providerId: 'local_conversation' },
                voicePrivacy: {
                    shareFilePaths: true,
                    shareSessionSummary: true,
                },
            }),
        );

        expect(hook.getCurrent().currentSession?.id).toBe('surface-session-1');
        expect(hook.getCurrent().currentSession?.metadata?.summaryText).toBe('Surface session');

        await hook.unmount();
    });

    it('follows ordinary runtime binding availability when its backing Session leaves and returns', async () => {
        const storage = getStorage();
        const conversation = createSessionFixture({
            id: 'account-a-voice-conversation', serverId: 'server-active',
        });
        voiceSessionBindingStore.getState().bind({
            adapterId: 'local_conversation',
            controlSessionId: 'account-a-control',
            conversationSessionId: 'account-a-voice-conversation',
            conversationSessionAddress: { serverId: 'server-active', sessionId: 'account-a-voice-conversation' },
            targetSessionAddress: { serverId: 'server-active', sessionId: 'account-a-target' },
            transcriptMode: 'native_session',
            updatedAt: 500,
        });
        storage.setState((state) => ({
            ...state,
            isDataReady: true,
            sessions: {},
            sessionMessages: {},
        }));

        const hook = await renderHook(() =>
            useVoiceSurfaceStoreState({
                activeControlSessionId: 'account-a-control',
                providerId: 'local_conversation',
                surfaceSessionId: null,
                transcriptEnabled: true,
                voiceSettings: { providerId: 'local_conversation' },
                voicePrivacy: {
                    shareFilePaths: true,
                    shareSessionSummary: true,
                },
            }),
        );

        expect(hook.getCurrent().openConversationSessionId).toBeNull();

        try {
            await act(async () => { storage.setState({ sessions: { [conversation.id]: conversation } }); });
            expect(hook.getCurrent().openConversationSessionId).toBe(conversation.id);
            await act(async () => { storage.setState({ sessions: {} }); });
            expect(hook.getCurrent().openConversationSessionId).toBeNull();
            await act(async () => { storage.setState({ sessions: { [conversation.id]: conversation } }); });
            expect(hook.getCurrent().openConversationSessionId).toBe(conversation.id);
        } finally {
            await hook.unmount();
        }
    });
});
