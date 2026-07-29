import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storage';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';

import { useVoiceSurfaceStoreState } from './useVoiceSurfaceStoreState';

const initialStorageState = getStorage().getState();
const initialBindingState = voiceSessionBindingStore.getState();

describe('useVoiceSurfaceStoreState', () => {
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
            targetSessionId: 'target-session-1',
            transcriptMode: 'native_session',
            updatedAt: 10,
        });
        storage.setState((state: any) => ({
            ...state,
            isDataReady: true,
            sessions: {
                ...state.sessions,
                'voice-conversation-1': {
                    id: 'voice-conversation-1',
                    metadata: {
                        path: '/tmp/voice-conversation-1',
                        host: 'localhost',
                    },
                    presence: 'online',
                },
            },
            sessionMessages: {
                ...state.sessionMessages,
                'voice-conversation-1': {
                    messageIdsOldestFirst: ['m1'],
                    messagesById: {
                        m1: {
                            id: 'm1',
                            kind: 'agent-text',
                            text: 'Hidden conversation reply',
                            createdAt: 5,
                        },
                    },
                },
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
        storage.setState((state: any) => ({
            ...state,
            isDataReady: true,
            sessions: {
                ...state.sessions,
                'surface-session-1': {
                    id: 'surface-session-1',
                    metadata: {
                        summaryText: 'Surface session',
                    },
                    presence: 'online',
                },
                'other-session': {
                    id: 'other-session',
                    metadata: {
                        summaryText: 'Unrelated session',
                    },
                    presence: 'online',
                },
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

    it('does not offer Open Conversation for a stale runtime binding after storage replacement', async () => {
        const storage = getStorage();
        voiceSessionBindingStore.getState().bind({
            adapterId: 'local_conversation',
            controlSessionId: 'account-a-control',
            conversationSessionId: 'account-a-voice-conversation',
            targetSessionId: 'account-a-target',
            transcriptMode: 'native_session',
            updatedAt: 500,
        });
        storage.setState((state: any) => ({
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

        await hook.unmount();
    });
});
