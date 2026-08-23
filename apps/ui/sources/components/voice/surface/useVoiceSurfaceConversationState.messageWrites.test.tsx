import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const BOUND_CONVERSATION_SESSION_ID = 'carrier-s1';

type StorageState = Readonly<{
    sessions: Record<string, unknown>;
    sessionMessages: Record<string, unknown>;
}>;

const storageState: { current: StorageState } = {
    current: { sessions: {}, sessionMessages: {} },
};
const storageListeners = new Set<() => void>();

vi.mock('@/sync/domains/state/storage', () => ({
    storage: {
        getState: () => storageState.current,
        subscribe: (listener: () => void) => {
            storageListeners.add(listener);
            return () => storageListeners.delete(listener);
        },
    },
}));

const STABLE_BINDING_STATE = {};
vi.mock('@/voice/binding/voiceConversationBindingStore', () => ({
    voiceSessionBindingStore: {
        getState: () => STABLE_BINDING_STATE,
        subscribe: () => () => {},
    },
}));

const BINDING = Object.freeze({
    adapterId: 'happier.voice.elevenlabs/realtime-elevenlabs',
    controlSessionId: 'voice-global',
    conversationSessionId: BOUND_CONVERSATION_SESSION_ID,
    transcriptMode: 'synthetic' as const,
    targetSessionId: 's1',
    updatedAt: 1,
});
vi.mock('@/voice/binding/resolveVoiceBindingBySessionId', () => ({
    resolveVoiceBindingBySessionId: () => BINDING,
}));
vi.mock('@/voice/agent/voiceAgentGlobalSessionId', () => ({
    VOICE_AGENT_GLOBAL_SESSION_ID: 'voice-global',
}));

function userMessage(seq: number) {
    return {
        id: `m-${seq}`,
        localId: `m-${seq}`,
        createdAt: seq,
        role: 'user' as const,
        content: { type: 'text', text: `msg-${seq}` },
    };
}

function commitStorage(next: StorageState): void {
    storageState.current = next;
    for (const listener of [...storageListeners]) listener();
}

/** A message write to a session this Voice surface is not bound to. */
function writeUnrelatedSessionMessages(index: number): void {
    commitStorage({
        ...storageState.current,
        sessionMessages: {
            ...storageState.current.sessionMessages,
            [`unrelated-${index}`]: { messages: [userMessage(index + 1)] },
        },
    });
}

beforeEach(() => {
    storageState.current = {
        sessions: {},
        sessionMessages: {
            [BOUND_CONVERSATION_SESSION_ID]: { messages: [userMessage(1)] },
        },
    };
});

afterEach(() => {
    storageListeners.clear();
});

/**
 * M3 — with the activity feed shown, the surface subscribed to the whole
 * `sessionMessages` map by identity, so every append in every other session
 * produced a new map reference and re-rendered the Voice surface. What it
 * depends on is the bound conversation's own message slice.
 */
describe('useVoiceSurfaceConversationState message-store subscription', () => {
    it('does not re-render on message writes to unrelated sessions', async () => {
        const { useVoiceSurfaceConversationState } = await import('./useVoiceSurfaceConversationState');
        let renders = 0;

        const hook = await renderHook(() => {
            renders += 1;
            return useVoiceSurfaceConversationState({
                providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
                activeControlSessionId: 'voice-global',
                surfaceSessionId: null,
                transcriptEnabled: true,
                voiceSettings: {},
            });
        });

        expect(hook.getCurrent().openConversationSessionId).toBe(BOUND_CONVERSATION_SESSION_ID);
        expect(hook.getCurrent().transcriptEntries).toHaveLength(1);
        const rendersAfterMount = renders;

        for (let index = 0; index < 5; index += 1) {
            await act(async () => {
                writeUnrelatedSessionMessages(index);
            });
        }

        expect(renders - rendersAfterMount).toBe(0);
        expect(hook.getCurrent().transcriptEntries).toHaveLength(1);

        await hook.unmount();
    });

    it('still observes writes to the bound conversation', async () => {
        const { useVoiceSurfaceConversationState } = await import('./useVoiceSurfaceConversationState');

        const hook = await renderHook(() =>
            useVoiceSurfaceConversationState({
                providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
                activeControlSessionId: 'voice-global',
                surfaceSessionId: null,
                transcriptEnabled: true,
                voiceSettings: {},
            }),
        );

        expect(hook.getCurrent().transcriptEntries).toHaveLength(1);

        await act(async () => {
            commitStorage({
                ...storageState.current,
                sessionMessages: {
                    ...storageState.current.sessionMessages,
                    [BOUND_CONVERSATION_SESSION_ID]: { messages: [userMessage(1), userMessage(2)] },
                },
            });
        });

        expect(hook.getCurrent().transcriptEntries.map((entry) => entry.id)).toEqual(['m-1', 'm-2']);

        await hook.unmount();
    });
});
