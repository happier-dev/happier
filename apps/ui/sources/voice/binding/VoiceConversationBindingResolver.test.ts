import { describe, expect, it } from 'vitest';

import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import type { Session } from '@/sync/domains/state/storageTypes';

import { writeVoiceConversationBindingMetadata } from './voiceConversationBindingMetadata';

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

describe('VoiceConversationBindingResolver', () => {
    it('prefers the newer persisted binding without mutating the runtime store', async () => {
        const { createVoiceSessionBindingStore } = await import('./voiceConversationBindingStore');
        const { createVoiceConversationBindingResolver } = await import('./VoiceConversationBindingResolver');

        const store = createVoiceSessionBindingStore();
        store.getState().bind({
            adapterId: 'local_conversation',
            controlSessionId: 'voice-global',
            conversationSessionId: 'carrier-s1',
            transcriptMode: 'synthetic',
            targetSessionId: 's1',
            updatedAt: 10,
        });

        const resolver = createVoiceConversationBindingResolver({
            getState: () => ({
                sessions: {
                    'carrier-s1': {
                        id: 'carrier-s1',
                        metadata: writeVoiceConversationBindingMetadata(
                            { systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } },
                            {
                                adapterId: 'local_conversation',
                                controlSessionId: 'voice-global',
                                conversationSessionId: 'carrier-s1',
                                transcriptMode: 'synthetic',
                                targetSessionId: 's2',
                                updatedAt: 25,
                            },
                        ),
                    },
                },
            }),
            store,
        });

        expect(resolver.resolveByConversationSessionId({ conversationSessionId: 'carrier-s1' })).toEqual({
            adapterId: 'local_conversation',
            controlSessionId: 'voice-global',
            conversationSessionId: 'carrier-s1',
            transcriptMode: 'synthetic',
            targetSessionId: 's2',
            updatedAt: 25,
        });
        expect(store.getState().getByConversationSessionId('carrier-s1')?.targetSessionId).toBe('s1');
    });

    it('resolves the latest binding for requested control sessions only', async () => {
        const { createVoiceSessionBindingStore } = await import('./voiceConversationBindingStore');
        const { createVoiceConversationBindingResolver } = await import('./VoiceConversationBindingResolver');

        const store = createVoiceSessionBindingStore();
        store.getState().bind({
            adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
            controlSessionId: 'voice-global',
            conversationSessionId: 'carrier-a',
            transcriptMode: 'synthetic',
            targetSessionId: 's1',
            updatedAt: 10,
        });
        store.getState().bind({
            adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
            controlSessionId: 'voice-other',
            conversationSessionId: 'carrier-b',
            transcriptMode: 'synthetic',
            targetSessionId: 's2',
            updatedAt: 20,
        });

        const resolver = createVoiceConversationBindingResolver({
            getState: () => ({
                sessions: {
                    'carrier-a': createTestSession('carrier-a', null),
                    'carrier-b': createTestSession('carrier-b', null),
                },
            }),
            store,
        });

        expect(
            resolver.resolveLatest({
                adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
                controlSessionIds: ['voice-global'],
            }),
        ).toEqual({
            adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
            controlSessionId: 'voice-global',
            conversationSessionId: 'carrier-a',
            transcriptMode: 'synthetic',
            targetSessionId: 's1',
            updatedAt: 10,
        });
    });

    it('derives a conversation route from the canonical binding resolver', async () => {
        const { createVoiceSessionBindingStore } = await import('./voiceConversationBindingStore');
        const { createVoiceConversationBindingResolver } = await import('./VoiceConversationBindingResolver');

        const store = createVoiceSessionBindingStore();
        store.getState().bind({
            adapterId: 'local_conversation',
            controlSessionId: 'voice-global',
            conversationSessionId: 'carrier-s1',
            transcriptMode: 'native_session',
            targetSessionId: null,
            updatedAt: 5,
        });

        const resolver = createVoiceConversationBindingResolver({
            getState: () => ({
                sessions: {
                    'carrier-s1': createTestSession('carrier-s1', null),
                },
            }),
            store,
        });

        expect(
            resolver.resolveComposerRouting({
                conversationSessionId: 'carrier-s1',
            }),
        ).toEqual({
            kind: 'adapter_text',
            binding: {
                adapterId: 'local_conversation',
                controlSessionId: 'voice-global',
                conversationSessionId: 'carrier-s1',
                transcriptMode: 'native_session',
                targetSessionId: null,
                updatedAt: 5,
            },
        });
    });

    it('falls back to direct session metadata when preferred lookup metadata does not carry the voice binding', async () => {
        const { createVoiceSessionBindingStore } = await import('./voiceConversationBindingStore');
        const { createVoiceConversationBindingResolver } = await import('./VoiceConversationBindingResolver');

        const store = createVoiceSessionBindingStore();
        const resolver = createVoiceConversationBindingResolver({
            getState: () => ({
                sessions: {
                    'carrier-s1': {
                        id: 'carrier-s1',
                        serverId: 'srv-1',
                        metadata: writeVoiceConversationBindingMetadata(
                            { systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } },
                            {
                                adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
                                controlSessionId: '__voice_agent__',
                                conversationSessionId: 'carrier-s1',
                                transcriptMode: 'synthetic',
                                targetSessionId: 'root-s1',
                                updatedAt: 10,
                            },
                        ),
                    },
                },
                sessionListIndexByServerId: {
                    'srv-1': [{ type: 'session', sessionId: 'carrier-s1', serverId: 'srv-1', serverName: 'Primary' }],
                },
                sessionListRenderables: {
                    'carrier-s1': {
                        id: 'carrier-s1',
                        metadata: { summaryText: 'Cached shell metadata only' },
                    },
                },
            }),
            store,
        });

        expect(
            resolver.resolveByControlSessionId({
                controlSessionId: '__voice_agent__',
                adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
            }),
        ).toEqual({
            adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
            controlSessionId: '__voice_agent__',
            conversationSessionId: 'carrier-s1',
            transcriptMode: 'synthetic',
            targetSessionId: 'root-s1',
            updatedAt: 10,
        });
    });

    it('recovers a binding by control session id from persisted metadata without mutating the store', async () => {
        const { createVoiceSessionBindingStore } = await import('./voiceConversationBindingStore');
        const { createVoiceConversationBindingResolver } = await import('./VoiceConversationBindingResolver');

        const store = createVoiceSessionBindingStore();
        const resolver = createVoiceConversationBindingResolver({
            getState: () => ({
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
            }),
            store,
        });

        expect(
            resolver.resolveByControlSessionId({
                controlSessionId: '__voice_agent__',
            }),
        ).toEqual({
            adapterId: 'local_conversation',
            controlSessionId: '__voice_agent__',
            conversationSessionId: 'carrier_s1',
            transcriptMode: 'native_session',
            targetSessionId: 's1',
            updatedAt: 123,
        });
        expect(store.getState().getByConversationSessionId('carrier_s1')).toBeNull();
    });

    it('prefers visible lookup binding metadata over stale raw session metadata for the same control session', async () => {
        const { createVoiceSessionBindingStore } = await import('./voiceConversationBindingStore');
        const { createVoiceConversationBindingResolver } = await import('./VoiceConversationBindingResolver');

        const store = createVoiceSessionBindingStore();
        const lookupMetadata = createTestSession(
            'carrier_raw',
            createVoiceConversationMetadata({
                adapterId: 'local_conversation',
                controlSessionId: '__voice_agent__',
                conversationSessionId: 'carrier_raw',
                transcriptMode: 'native_session',
                targetSessionId: 'lookup-target',
                updatedAt: 30,
            }),
        ).metadata;
        const resolver = createVoiceConversationBindingResolver({
            getState: () => ({
                sessions: {
                    carrier_raw: createTestSession(
                        'carrier_raw',
                        createVoiceConversationMetadata({
                            adapterId: 'local_conversation',
                            controlSessionId: '__voice_agent__',
                            conversationSessionId: 'carrier_raw',
                            transcriptMode: 'native_session',
                            targetSessionId: 'raw-target',
                            updatedAt: 10,
                        }),
                    ),
                },
                sessionListRenderables: {
                    carrier_raw: createSessionListRenderableSessionFixture({
                        id: 'carrier_raw',
                        metadata: lookupMetadata,
                    }),
                },
                sessionListIndexByServerId: {
                    'server-a': [
                        { type: 'session', sessionId: 'carrier_raw', serverId: 'server-a', serverName: 'Server A' },
                    ],
                },
            }),
            store,
        });

        expect(
            resolver.resolveByControlSessionId({
                controlSessionId: '__voice_agent__',
            }),
        ).toEqual({
            adapterId: 'local_conversation',
            controlSessionId: '__voice_agent__',
            conversationSessionId: 'carrier_raw',
            transcriptMode: 'native_session',
            targetSessionId: 'lookup-target',
            updatedAt: 30,
        });
    });

    it('returns the latest matching binding across recovered and in-memory entries', async () => {
        const { createVoiceSessionBindingStore } = await import('./voiceConversationBindingStore');
        const { createVoiceConversationBindingResolver } = await import('./VoiceConversationBindingResolver');

        const store = createVoiceSessionBindingStore();
        store.getState().bind({
            adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
            controlSessionId: 'session_a',
            conversationSessionId: 'carrier_old',
            transcriptMode: 'synthetic',
            targetSessionId: 's1',
            updatedAt: 100,
        });
        const resolver = createVoiceConversationBindingResolver({
            getState: () => ({
                sessions: {
                    carrier_new: createTestSession(
                        'carrier_new',
                        createVoiceConversationMetadata({
                            adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
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
            }),
            store,
        });

        const binding = resolver.resolveLatest({
            adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
            controlSessionIds: ['session_a'],
        });

        expect(binding?.conversationSessionId).toBe('carrier_new');
        expect(store.getState().getByControlSessionId('session_a')?.conversationSessionId).toBe('carrier_old');
    });

    it('rejects a newer runtime binding from replaced storage and resolves the current persisted binding', async () => {
        const { createVoiceSessionBindingStore } = await import('./voiceConversationBindingStore');
        const { createVoiceConversationBindingResolver } = await import('./VoiceConversationBindingResolver');

        const store = createVoiceSessionBindingStore();
        store.getState().bind({
            adapterId: 'local_conversation',
            controlSessionId: '__voice_agent__',
            conversationSessionId: 'account-a-voice-conversation',
            transcriptMode: 'native_session',
            targetSessionId: 'account-a-target',
            updatedAt: 500,
        });
        const resolver = createVoiceConversationBindingResolver({
            getState: () => ({
                sessions: {
                    'account-b-voice-conversation': createTestSession(
                        'account-b-voice-conversation',
                        createVoiceConversationMetadata({
                            adapterId: 'local_conversation',
                            controlSessionId: '__voice_agent__',
                            conversationSessionId: 'account-b-voice-conversation',
                            transcriptMode: 'native_session',
                            targetSessionId: 'account-b-target',
                            updatedAt: 100,
                        }),
                    ),
                },
            }),
            store,
        });

        expect(
            resolver.resolveByControlSessionId({
                controlSessionId: '__voice_agent__',
                adapterId: 'local_conversation',
            }),
        ).toEqual({
            adapterId: 'local_conversation',
            controlSessionId: '__voice_agent__',
            conversationSessionId: 'account-b-voice-conversation',
            transcriptMode: 'native_session',
            targetSessionId: 'account-b-target',
            updatedAt: 100,
        });
    });

    it('keeps an exact runtime-attempt binding resolvable without a persisted conversation session', async () => {
        const { createVoiceSessionBindingStore } = await import('./voiceConversationBindingStore');
        const { createVoiceConversationBindingResolver } = await import('./VoiceConversationBindingResolver');

        const store = createVoiceSessionBindingStore();
        const runtimeAttemptBinding = {
            adapterId: 'happier.voice.openai/realtime-openai',
            controlSessionId: 'account-b-control',
            conversationSessionId: 'voice-direct-media:attempt-b',
            lifetime: 'runtime_attempt' as const,
            transcriptMode: 'synthetic' as const,
            targetSessionId: 'account-b-target',
            updatedAt: 700,
        };
        store.getState().bind(runtimeAttemptBinding);
        const resolver = createVoiceConversationBindingResolver({
            getState: () => ({ sessions: {} }),
            store,
        });

        expect(
            resolver.resolveByControlSessionId({
                controlSessionId: 'account-b-control',
                adapterId: 'happier.voice.openai/realtime-openai',
            }),
        ).toEqual(runtimeAttemptBinding);
        expect(
            resolver.resolveByConversationSessionId({
                conversationSessionId: 'voice-direct-media:attempt-b',
            }),
        ).toEqual(runtimeAttemptBinding);
    });
});
