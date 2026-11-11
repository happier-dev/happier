import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UserTextMessage } from '@happier-dev/session-core/messages';

import { createSessionFixture, createSessionMessagesFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storage';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { registerVoiceAdapters } from '@/voice/session/voiceAdapterRegistry';
import type { VoiceAdapterController } from '@/voice/session/types';
import { useVoiceSurfaceConversationState } from './useVoiceSurfaceConversationState';
import { observeStorageSubscriptionDeliveries } from '@/dev/testkit/performance/storageSubscriptionCensus';

const PROVIDER_ID = 'happier.voice.elevenlabs/realtime-elevenlabs';
const CONVERSATION_ID = 'carrier-s1';
const initialStorageState = getStorage().getState();
const initialBindingState = voiceSessionBindingStore.getState();

function messages(...texts: string[]) {
    const entries = texts.map((text, index): UserTextMessage => ({
        kind: 'user-text', id: `m${index + 1}`, localId: null, createdAt: index + 1, text,
    }));
    return createSessionMessagesFixture({
        messageIdsOldestFirst: entries.map((entry) => entry.id),
        messagesById: Object.fromEntries(entries.map((entry) => [entry.id, entry])),
    });
}

function bindConversation(adapterId = PROVIDER_ID): void {
    voiceSessionBindingStore.getState().bind({
        adapterId,
        controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        conversationSessionId: CONVERSATION_ID,
        conversationSessionAddress: { serverId: 'server-active', sessionId: CONVERSATION_ID },
        transcriptMode: 'synthetic',
        targetSessionAddress: { serverId: 'server-active', sessionId: 's1' },
        updatedAt: 1,
    });
}

beforeEach(() => {
    getStorage().setState(initialStorageState, true);
    voiceSessionBindingStore.setState(initialBindingState, true);
    registerVoiceAdapters([]);
    getStorage().setState({
        sessions: { [CONVERSATION_ID]: createSessionFixture({ id: CONVERSATION_ID, serverId: 'server-active' }) },
        sessionMessages: { [CONVERSATION_ID]: messages('hello') },
    });
    bindConversation();
});

afterEach(() => {
    standardCleanup();
    registerVoiceAdapters([]);
    getStorage().setState(initialStorageState, true);
    voiceSessionBindingStore.setState(initialBindingState, true);
});

function surface(transcriptEnabled: boolean, activeControlSessionId: string | null = VOICE_AGENT_GLOBAL_SESSION_ID, providerId = PROVIDER_ID) {
    return useVoiceSurfaceConversationState({
        providerId, activeControlSessionId, surfaceSessionId: null, transcriptEnabled, voiceSettings: {},
    });
}

describe('useVoiceSurfaceConversationState transcript gating (L10.T4)', () => {
    it('keeps the latest 50 visible rows in owner event order', async () => {
        getStorage().setState({ sessionMessages: { [CONVERSATION_ID]: messages(...Array.from({ length: 51 }, (_, index) => `turn-${index + 1}`)) } });
        const hook = await renderHook(() => surface(true));
        expect(hook.getCurrent().transcriptEntries).toHaveLength(51);
        expect(hook.getCurrent().visibleTranscriptEntries.map((entry) => entry.id)).toEqual(
            Array.from({ length: 50 }, (_, index) => `m${index + 2}`),
        );
    });

    it('does not project transcript entries when the activity feed is disabled', async () => {
        // A disabled feed must never read message contents; the binding remains
        // navigable independently. This fails if projection happens then is hidden.
        const unreadableSlice = createSessionMessagesFixture();
        Object.defineProperty(unreadableSlice, 'messagesById', {
            get: () => { throw new Error('Disabled transcript read its message contents'); },
        });
        getStorage().setState({ sessionMessages: { [CONVERSATION_ID]: unreadableSlice } });
        const hook = await renderHook(() => surface(false));

        expect(hook.getCurrent().transcriptEntries).toHaveLength(0);
        expect(hook.getCurrent().visibleTranscriptEntries).toHaveLength(0);
        expect(hook.getCurrent().openConversationSessionId).toBe(CONVERSATION_ID);
    });

    it('projects transcript entries when the activity feed is enabled', async () => {
        const hook = await renderHook(() => surface(true));

        expect(hook.getCurrent().transcriptEntries).toEqual([{
            id: 'm1', createdAt: 1, kind: 'user', text: 'hello',
            transcriptState: 'final', announce: false, announcementId: 'voice-persisted:m1',
        }]);
        expect(hook.getCurrent().visibleTranscriptEntries).toMatchObject([{ id: 'm1', text: 'hello' }]);
    });

    it('ignores sessionMessages changes while the feed is disabled (no re-projection)', async () => {
        let renders = 0;
        const delivery = observeStorageSubscriptionDeliveries();
        const hook = await renderHook(({ enabled }) => { renders += 1; return surface(enabled); }, { initialProps: { enabled: false } });
        const before = hook.getCurrent();
        const rendersBeforeWrite = renders;
        delivery.reset();
        await act(async () => {
            getStorage().setState({ sessionMessages: { [CONVERSATION_ID]: messages('hello', 'world') } });
        });

        expect(renders).toBe(rendersBeforeWrite);
        expect(delivery.count).toBe(0);
        expect(hook.getCurrent().transcriptEntries).toBe(before.transcriptEntries);
        expect(hook.getCurrent().transcriptEntries).toHaveLength(0);
        await hook.rerender({ enabled: true });
        expect(hook.getCurrent().transcriptEntries).toHaveLength(2);
        await hook.unmount();
        delivery.restore();
    });

    it('uses a second realtime provider global control scope without host edits', async () => {
        registerVoiceAdapters([createSurfaceAdapter('realtime_second_provider', 'global')]);
        voiceSessionBindingStore.setState(initialBindingState, true);
        bindConversation('realtime_second_provider');
        const hook = await renderHook(() => surface(false, null, 'realtime_second_provider'));

        expect(hook.getCurrent().fallbackOpenConversationControlSessionId).toBe(VOICE_AGENT_GLOBAL_SESSION_ID);
        expect(hook.getCurrent().openConversationSessionId).toBe(CONVERSATION_ID);
    });

    it('does not invent a global control session for a disabled provider', async () => {
        const hook = await renderHook(() => surface(false, null));

        expect(hook.getCurrent().fallbackOpenConversationControlSessionId).toBeNull();
        expect(hook.getCurrent().openConversationSessionId).toBeNull();
    });
});

function createSurfaceAdapter(id: string, controlSessionScope: 'surface' | 'global'): VoiceAdapterController {
    return {
        id, engineKind: 'realtime', start: async () => {}, stop: async () => {}, toggle: async () => {},
        interrupt: async () => {}, setMuted: async () => {}, sendContextUpdate: () => {},
        getSnapshot: () => ({ adapterId: id, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false }),
        resolveSurfaceCapabilities: () => ({
            allowsGlobalStart: controlSessionScope === 'global', controlSessionScope,
            requiresVoiceAgentFeature: false, bargeInEnabled: false,
        }),
    };
}
