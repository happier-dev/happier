import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UserTextMessage } from '@happier-dev/session-core/messages';

import { createSessionFixture, createSessionMessagesFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storage';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import type { VoiceSessionBinding } from '@/voice/binding/voiceConversationBindingTypes';
import { useVoiceSurfaceConversationState } from './useVoiceSurfaceConversationState';
import { observeStorageSubscriptionDeliveries } from '@/dev/testkit/performance/storageSubscriptionCensus';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BOUND_CONVERSATION_SESSION_ID = 'carrier-s1';

const initialStorageState = getStorage().getState();
const initialBindingState = voiceSessionBindingStore.getState();
const BINDING = Object.freeze({
    adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
    controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
    conversationSessionId: BOUND_CONVERSATION_SESSION_ID,
    conversationSessionAddress: { serverId: 'server-active', sessionId: BOUND_CONVERSATION_SESSION_ID },
    transcriptMode: 'synthetic' as const,
    targetSessionAddress: { serverId: 'server-active', sessionId: 's1' },
    updatedAt: 1,
} satisfies VoiceSessionBinding);

function userMessage(seq: number): UserTextMessage {
    return {
        id: `m-${seq}`,
        localId: `m-${seq}`,
        createdAt: seq,
        kind: 'user-text',
        text: `msg-${seq}`,
    };
}

function conversationMessages(...sequence: number[]) {
    const messages = sequence.map(userMessage);
    return createSessionMessagesFixture({
        messageIdsOldestFirst: messages.map((message) => message.id),
        messagesById: Object.fromEntries(messages.map((message) => [message.id, message])),
    });
}

/** A message write to a session this Voice surface is not bound to. */
function writeUnrelatedSessionMessages(index: number): void {
    getStorage().setState((state) => ({
        sessionMessages: {
            ...state.sessionMessages,
            [`unrelated-${index}`]: conversationMessages(index + 1),
        },
    }));
}

beforeEach(() => {
    getStorage().setState(initialStorageState, true);
    voiceSessionBindingStore.setState(initialBindingState, true);
    getStorage().setState({
        sessions: { [BOUND_CONVERSATION_SESSION_ID]: createSessionFixture({ id: BOUND_CONVERSATION_SESSION_ID, serverId: 'server-active' }) },
        sessionMessages: {
            [BOUND_CONVERSATION_SESSION_ID]: conversationMessages(1),
        },
    });
    voiceSessionBindingStore.getState().bind(BINDING);
});

afterEach(() => {
    standardCleanup();
    getStorage().setState(initialStorageState, true);
    voiceSessionBindingStore.setState(initialBindingState, true);
});

/**
 * M3 — with the activity feed shown, the surface subscribed to the whole
 * `sessionMessages` map by identity, so every append in every other session
 * produced a new map reference and re-rendered the Voice surface. What it
 * depends on is the bound conversation's own message slice.
 */
describe('useVoiceSurfaceConversationState message-store subscription', () => {
    it('does not re-render on message writes to unrelated sessions', async () => {
        let renders = 0;
        const delivery = observeStorageSubscriptionDeliveries();

        const hook = await renderHook(() => {
            renders += 1;
            return useVoiceSurfaceConversationState({
                providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
                activeControlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
                surfaceSessionId: null,
                transcriptEnabled: true,
                voiceSettings: {},
            });
        });

        expect(hook.getCurrent().openConversationSessionId).toBe(BOUND_CONVERSATION_SESSION_ID);
        expect(hook.getCurrent().transcriptEntries).toHaveLength(1);
        const rendersAfterMount = renders;
        delivery.reset();

        for (let index = 0; index < 5; index += 1) {
            await act(async () => {
                writeUnrelatedSessionMessages(index);
            });
        }

        expect(renders - rendersAfterMount).toBe(0);
        expect(delivery.count).toBe(0);
        expect(hook.getCurrent().transcriptEntries).toHaveLength(1);

        await act(async () => { getStorage().setState(state => ({ sessionMessages: {
            ...state.sessionMessages, [BOUND_CONVERSATION_SESSION_ID]: conversationMessages(1, 2),
        } })); });
        expect(delivery.count).toBeGreaterThan(0);
        expect(hook.getCurrent().transcriptEntries).toHaveLength(2);

        await hook.unmount();
        delivery.restore();
    });

    it('still observes writes to the bound conversation', async () => {

        const hook = await renderHook(() =>
            useVoiceSurfaceConversationState({
                providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
                activeControlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
                surfaceSessionId: null,
                transcriptEnabled: true,
                voiceSettings: {},
            }),
        );

        expect(hook.getCurrent().transcriptEntries).toHaveLength(1);

        await act(async () => {
            getStorage().setState((state) => ({
                sessionMessages: {
                    ...state.sessionMessages,
                    [BOUND_CONVERSATION_SESSION_ID]: conversationMessages(1, 2),
                },
            }));
        });

        expect(hook.getCurrent().transcriptEntries.map((entry) => entry.id)).toEqual(['m-1', 'm-2']);

        await hook.unmount();
    });
});
