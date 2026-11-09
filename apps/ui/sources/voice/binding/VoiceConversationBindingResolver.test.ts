import { beforeEach, describe, expect, it } from 'vitest';

import { createSessionFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { selectActiveTestHomeForTests } from '@/dev/testkit/fixtures/persistedHomeProfiles';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { Session } from '@/sync/domains/state/storageTypes';

import { writeVoiceConversationBindingMetadata } from './voiceConversationBindingMetadata';

// Cold source-graph transformation is setup, not part of a binding lookup's
// operation budget. Warm the real owners once without substituting their logic.
await import('./voiceConversationBindingStore');
await import('./VoiceConversationBindingResolver');

// The unconfigured test build seeds no Home: select the same one before collection and each test.
await selectActiveTestHomeForTests();
beforeEach(async () => { await selectActiveTestHomeForTests(); });
/** Every binding target is Home-qualified; the persisted record carries its own server id. */
const activeServerId = getActiveServerSnapshot().serverId;

function address(serverId: string, sessionId: string): SessionAddress {
    return { serverId, sessionId };
}

function createVoiceConversationMetadata(binding: Readonly<{
    adapterId: string;
    controlSessionId: string;
    conversationSessionId: string;
    transcriptMode: 'synthetic' | 'native_session';
    targetSessionAddress: SessionAddress | null;
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
        {
            ...binding,
            conversationSessionAddress: address(activeServerId, binding.conversationSessionId),
        },
    );
}

function createTestSession(id: string, metadata: Record<string, unknown> | null): Session {
    return createSessionFixture({
        id,
        serverId: activeServerId,
        active: true,
        metadata: {
            ...createSessionFixture().metadata,
            path: '',
            host: '',
            ...(metadata ?? {}),
        },
    });
}

describe('VoiceConversationBindingResolver', () => {
    it('preserves a locally admitted binding when another device publishes a newer target', async () => {
        const { createVoiceSessionBindingStore } = await import('./voiceConversationBindingStore');
        const { createVoiceConversationBindingResolver } = await import('./VoiceConversationBindingResolver');

        const store = createVoiceSessionBindingStore();
        store.getState().bind({
            adapterId: 'local_conversation',
            controlSessionId: 'voice-global',
            conversationSessionId: 'carrier-s1',
            conversationSessionAddress: address(activeServerId, 'carrier-s1'),
            transcriptMode: 'synthetic',
            targetSessionAddress: address(activeServerId, 's1'),
            updatedAt: 10,
        });

        const resolver = createVoiceConversationBindingResolver({
            getState: () => ({
                sessions: {
                    'carrier-s1': {
                        id: 'carrier-s1',
                        serverId: activeServerId,
                        metadata: writeVoiceConversationBindingMetadata(
                            { systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true } },
                            {
                                adapterId: 'local_conversation',
                                controlSessionId: 'voice-global',
                                conversationSessionId: 'carrier-s1',
                                conversationSessionAddress: address(activeServerId, 'carrier-s1'),
                                transcriptMode: 'synthetic',
                                targetSessionAddress: address(activeServerId, 's2'),
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
            conversationSessionAddress: address(activeServerId, 'carrier-s1'),
            transcriptMode: 'synthetic',
            targetSessionAddress: address(activeServerId, 's1'),
            updatedAt: 10,
        });
        expect(store.getState().getByConversationSessionId('carrier-s1')?.targetSessionAddress)
            .toEqual(address(activeServerId, 's1'));
    });

    it('resolves the latest binding for requested control sessions only', async () => {
        const { createVoiceSessionBindingStore } = await import('./voiceConversationBindingStore');
        const { createVoiceConversationBindingResolver } = await import('./VoiceConversationBindingResolver');

        const store = createVoiceSessionBindingStore();
        store.getState().bind({
            adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
            controlSessionId: 'voice-global',
            conversationSessionId: 'carrier-a',
            conversationSessionAddress: address(activeServerId, 'carrier-a'),
            transcriptMode: 'synthetic',
            targetSessionAddress: address(activeServerId, 's1'),
            updatedAt: 10,
        });
        store.getState().bind({
            adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
            controlSessionId: 'voice-other',
            conversationSessionId: 'carrier-b',
            conversationSessionAddress: address(activeServerId, 'carrier-b'),
            transcriptMode: 'synthetic',
            targetSessionAddress: address(activeServerId, 's2'),
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
            conversationSessionAddress: address(activeServerId, 'carrier-a'),
            transcriptMode: 'synthetic',
            targetSessionAddress: address(activeServerId, 's1'),
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
            conversationSessionAddress: address(activeServerId, 'carrier-s1'),
            transcriptMode: 'native_session',
            targetSessionAddress: null,
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
                conversationSessionAddress: address(activeServerId, 'carrier-s1'),
                transcriptMode: 'native_session',
                targetSessionAddress: null,
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
                                conversationSessionAddress: address('srv-1', 'carrier-s1'),
                                transcriptMode: 'synthetic',
                                targetSessionAddress: address('srv-1', 'root-s1'),
                                updatedAt: 10,
                            },
                        ),
                    },
                },
                sessionListIndexByServerId: {
                    'srv-1': [{ type: 'session', sessionId: 'carrier-s1', serverId: 'srv-1', serverName: 'Primary' }],
                },
                sessionListRowsByServerId: {
                    'srv-1': {
                        'carrier-s1': {
                            id: 'carrier-s1',
                            metadata: { summaryText: 'Cached shell metadata only' },
                        },
                    },
                },
                ordinarySessionListMembershipByServerId: { 'srv-1': ['carrier-s1'] },
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
            conversationSessionAddress: address('srv-1', 'carrier-s1'),
            transcriptMode: 'synthetic',
            targetSessionAddress: address('srv-1', 'root-s1'),
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
                            targetSessionAddress: address(activeServerId, 's1'),
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
            conversationSessionAddress: address(activeServerId, 'carrier_s1'),
            transcriptMode: 'native_session',
            targetSessionAddress: address(activeServerId, 's1'),
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
                targetSessionAddress: address('server-a', 'lookup-target'),
                updatedAt: 30,
            }),
        ).metadata;
        const resolver = createVoiceConversationBindingResolver({
            getState: () => ({
                sessions: {
                    carrier_raw: {
                        ...createTestSession(
                            'carrier_raw',
                            createVoiceConversationMetadata({
                                adapterId: 'local_conversation',
                                controlSessionId: '__voice_agent__',
                                conversationSessionId: 'carrier_raw',
                                transcriptMode: 'native_session',
                                targetSessionAddress: address('server-a', 'raw-target'),
                                updatedAt: 10,
                            }),
                        ),
                        serverId: 'server-a',
                    },
                },
                sessionListRowsByServerId: {
                    'server-a': {
                        carrier_raw: createSessionListRenderableSessionFixture({
                            id: 'carrier_raw',
                            metadata: lookupMetadata,
                        }),
                    },
                },
                ordinarySessionListMembershipByServerId: { 'server-a': ['carrier_raw'] },
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
            conversationSessionAddress: address('server-a', 'carrier_raw'),
            transcriptMode: 'native_session',
            targetSessionAddress: address('server-a', 'lookup-target'),
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
            conversationSessionAddress: address(activeServerId, 'carrier_old'),
            transcriptMode: 'synthetic',
            targetSessionAddress: address(activeServerId, 's1'),
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
                            targetSessionAddress: address(activeServerId, 's2'),
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
                            targetSessionAddress: null,
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
            conversationSessionAddress: address(activeServerId, 'account-a-voice-conversation'),
            transcriptMode: 'native_session',
            targetSessionAddress: address(activeServerId, 'account-a-target'),
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
                            targetSessionAddress: address(activeServerId, 'account-b-target'),
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
            conversationSessionAddress: address(activeServerId, 'account-b-voice-conversation'),
            transcriptMode: 'native_session',
            targetSessionAddress: address(activeServerId, 'account-b-target'),
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
            conversationSessionAddress: address(activeServerId, 'voice-direct-media:attempt-b'),
            lifetime: 'runtime_attempt' as const,
            transcriptMode: 'synthetic' as const,
            targetSessionAddress: address(activeServerId, 'account-b-target'),
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
