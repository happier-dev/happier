import { beforeEach, describe, expect, it } from 'vitest';

import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';

import { createVoiceSessionBindingStore } from './voiceSessionBindingStore';
import { writeVoiceConversationBindingMetadata } from './voiceConversationBindingMetadata';
import {
    resolveLatestVoiceSessionBinding,
    resolveVoiceSessionBindingByControlSessionId,
    resolveVoiceSessionBindingByConversationSessionId,
} from './resolveVoiceSessionBinding';

function createVoiceConversationMetadata(binding: Readonly<{
    adapterId: string;
    controlSessionId: string;
    conversationSessionId: string;
    transcriptMode: 'synthetic' | 'native_session';
    targetSessionId: string | null;
    updatedAt: number;
}>) {
    return writeVoiceConversationBindingMetadata(
        {
            systemSessionV1: {
                v: 1,
                key: 'voice_conversation',
                hidden: true,
            },
        },
        binding,
    );
}

function createTestSession(id: string, metadata: Record<string, unknown> | null): Session {
    return {
        id,
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: {
            path: '',
            host: '',
            ...(metadata ?? {}),
        },
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
    };
}

describe('resolveVoiceSessionBinding', () => {
    beforeEach(() => {
        storage.setState((current) => ({
            ...current,
            sessions: {},
        }));
    });

    it('recovers a binding by control session id from persisted metadata and hydrates the store', () => {
        const store = createVoiceSessionBindingStore();
        storage.setState((current) => ({
            ...current,
            sessions: {
                carrier_s1: createTestSession(
                    'carrier_s1',
                    createVoiceConversationMetadata({
                        adapterId: 'local_conversation',
                        controlSessionId: '__voice_agent__',
                        conversationSessionId: 'carrier_s1',
                        transcriptMode: 'native_session',
                        targetSessionId: 's1',
                        updatedAt: 123,
                    }),
                ),
            },
        }));

        const binding = resolveVoiceSessionBindingByControlSessionId({
            controlSessionId: '__voice_agent__',
            store,
        });

        expect(binding).toEqual({
            adapterId: 'local_conversation',
            controlSessionId: '__voice_agent__',
            conversationSessionId: 'carrier_s1',
            transcriptMode: 'native_session',
            targetSessionId: 's1',
            updatedAt: 123,
        });
        expect(store.getState().getByConversationSessionId('carrier_s1')).toEqual(binding);
    });

    it('prefers the newer persisted binding over a stale in-memory control-session binding', () => {
        const store = createVoiceSessionBindingStore();
        store.getState().bind({
            adapterId: 'local_conversation',
            controlSessionId: '__voice_agent__',
            conversationSessionId: 'carrier_old',
            transcriptMode: 'native_session',
            targetSessionId: 's1',
            updatedAt: 100,
        });
        storage.setState((current) => ({
            ...current,
            sessions: {
                carrier_new: createTestSession(
                    'carrier_new',
                    createVoiceConversationMetadata({
                        adapterId: 'local_conversation',
                        controlSessionId: '__voice_agent__',
                        conversationSessionId: 'carrier_new',
                        transcriptMode: 'native_session',
                        targetSessionId: 's2',
                        updatedAt: 200,
                    }),
                ),
            },
        }));

        const binding = resolveVoiceSessionBindingByControlSessionId({
            controlSessionId: '__voice_agent__',
            store,
        });

        expect(binding?.conversationSessionId).toBe('carrier_new');
        expect(binding?.targetSessionId).toBe('s2');
        expect(store.getState().getByControlSessionId('__voice_agent__')?.conversationSessionId).toBe('carrier_new');
        expect(store.getState().getByConversationSessionId('carrier_old')).toBeNull();
    });

    it('recovers a binding by conversation session id from session metadata when runtime bindings are empty', () => {
        const store = createVoiceSessionBindingStore();

        const binding = resolveVoiceSessionBindingByConversationSessionId({
            conversationSessionId: 'carrier_s1',
            sessionMetadata: createVoiceConversationMetadata({
                adapterId: 'realtime_elevenlabs',
                controlSessionId: '__voice_agent__',
                conversationSessionId: 'carrier_s1',
                transcriptMode: 'synthetic',
                targetSessionId: null,
                updatedAt: 321,
            }),
            store,
        });

        expect(binding).toEqual({
            adapterId: 'realtime_elevenlabs',
            controlSessionId: '__voice_agent__',
            conversationSessionId: 'carrier_s1',
            transcriptMode: 'synthetic',
            targetSessionId: null,
            updatedAt: 321,
        });
        expect(store.getState().getByConversationSessionId('carrier_s1')).toEqual(binding);
    });

    it('returns the latest matching binding across recovered and in-memory entries', () => {
        const store = createVoiceSessionBindingStore();
        store.getState().bind({
            adapterId: 'realtime_elevenlabs',
            controlSessionId: 'session_a',
            conversationSessionId: 'carrier_old',
            transcriptMode: 'synthetic',
            targetSessionId: 's1',
            updatedAt: 100,
        });
        storage.setState((current) => ({
            ...current,
            sessions: {
                carrier_new: createTestSession(
                    'carrier_new',
                    createVoiceConversationMetadata({
                        adapterId: 'realtime_elevenlabs',
                        controlSessionId: 'session_a',
                        conversationSessionId: 'carrier_new',
                        transcriptMode: 'synthetic',
                        targetSessionId: 's2',
                        updatedAt: 400,
                    }),
                ),
                carrier_other: createTestSession(
                    'carrier_other',
                    createVoiceConversationMetadata({
                        adapterId: 'local_conversation',
                        controlSessionId: '__voice_agent__',
                        conversationSessionId: 'carrier_other',
                        transcriptMode: 'native_session',
                        targetSessionId: null,
                        updatedAt: 500,
                    }),
                ),
            },
        }));

        const binding = resolveLatestVoiceSessionBinding({
            adapterId: 'realtime_elevenlabs',
            controlSessionIds: ['session_a'],
            store,
        });

        expect(binding?.conversationSessionId).toBe('carrier_new');
        expect(store.getState().getByControlSessionId('session_a')?.conversationSessionId).toBe('carrier_new');
    });
});
