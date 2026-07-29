import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit';
import { registerVoiceAdapters } from '@/voice/session/voiceAdapterRegistry';
import type { VoiceAdapterController } from '@/voice/session/types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const storageState: { current: any } = { current: { sessions: {}, sessionMessages: {} } };
const storageListeners = new Set<() => void>();
const mockedStorage = {
    getState: () => storageState.current,
    subscribe: (listener: () => void) => {
        storageListeners.add(listener);
        return () => storageListeners.delete(listener);
    },
    setState: (next: any) => {
        storageState.current = next;
        for (const listener of storageListeners) listener();
    },
};

vi.mock('@/sync/domains/state/storage', () => ({
    storage: { getState: () => mockedStorage.getState(), subscribe: (l: () => void) => mockedStorage.subscribe(l) },
}));

const projectSpy = vi.fn((..._args: unknown[]) => [
    { id: 'm1', createdAt: 1, kind: 'user' as const, text: 'hello' },
]);
vi.mock('@/voice/transcript/voiceTranscriptSelectors', () => ({
    selectVoiceTranscriptEntriesForConversationSession: (state: unknown, conversationSessionId: unknown) =>
        projectSpy(state, conversationSessionId),
}));

const bindingState = {
    current: {
        adapterId: 'realtime_elevenlabs',
        controlSessionId: 'voice-global',
        conversationSessionId: 'carrier-s1',
        transcriptMode: 'synthetic' as const,
        targetSessionId: 's1',
        updatedAt: 1,
    } as any,
};
const resolveBindingSpy = vi.fn<(input: unknown) => typeof bindingState.current>((_input) => bindingState.current);
vi.mock('@/voice/binding/resolveVoiceBindingBySessionId', () => ({
    resolveVoiceBindingBySessionId: (input: unknown) => {
        resolveBindingSpy(input);
        return bindingState.current;
    },
}));
const STABLE_BINDING_STATE = {};
vi.mock('@/voice/binding/voiceConversationBindingStore', () => ({
    voiceSessionBindingStore: { getState: () => STABLE_BINDING_STATE, subscribe: () => () => {} },
}));
vi.mock('@/voice/agent/voiceAgentGlobalSessionId', () => ({ VOICE_AGENT_GLOBAL_SESSION_ID: 'voice-global' }));

beforeEach(() => {
    projectSpy.mockClear();
    resolveBindingSpy.mockClear();
    registerVoiceAdapters([]);
    storageState.current = {
        sessions: {},
        sessionMessages: { 'carrier-s1': { messages: [{ id: 'm1', createdAt: 1, role: 'user', content: { type: 'text', text: 'hello' } }] } },
    };
});

afterEach(() => {
    storageListeners.clear();
});

describe('useVoiceSurfaceConversationState transcript gating (L10.T4)', () => {
    it('does not project transcript entries when the activity feed is disabled', async () => {
        const { useVoiceSurfaceConversationState } = await import('./useVoiceSurfaceConversationState');
        const { getCurrent } = await renderHook(() =>
            useVoiceSurfaceConversationState({
                providerId: 'realtime_elevenlabs',
                activeControlSessionId: 'voice-global',
                surfaceSessionId: null,
                transcriptEnabled: false,
                voiceSettings: {},
            }),
        );

        expect(getCurrent().transcriptEntries).toHaveLength(0);
        expect(getCurrent().visibleTranscriptEntries).toHaveLength(0);
        // The open-conversation affordance still resolves regardless of feed state.
        expect(getCurrent().openConversationSessionId).toBe('carrier-s1');
        expect(projectSpy).not.toHaveBeenCalled();
    });

    it('projects transcript entries when the activity feed is enabled', async () => {
        const { useVoiceSurfaceConversationState } = await import('./useVoiceSurfaceConversationState');
        const { getCurrent } = await renderHook(() =>
            useVoiceSurfaceConversationState({
                providerId: 'realtime_elevenlabs',
                activeControlSessionId: 'voice-global',
                surfaceSessionId: null,
                transcriptEnabled: true,
                voiceSettings: {},
            }),
        );

        expect(projectSpy).toHaveBeenCalled();
        expect(getCurrent().transcriptEntries).toHaveLength(1);
        expect(getCurrent().visibleTranscriptEntries).toHaveLength(1);
    });

    it('ignores sessionMessages changes while the feed is disabled (no re-projection)', async () => {
        const { useVoiceSurfaceConversationState } = await import('./useVoiceSurfaceConversationState');
        const { getCurrent } = await renderHook(() =>
            useVoiceSurfaceConversationState({
                providerId: 'realtime_elevenlabs',
                activeControlSessionId: 'voice-global',
                surfaceSessionId: null,
                transcriptEnabled: false,
                voiceSettings: {},
            }),
        );

        const { act } = await import('react-test-renderer');
        await act(async () => {
            mockedStorage.setState({
                ...storageState.current,
                sessionMessages: {
                    'carrier-s1': { messages: [
                        { id: 'm1', createdAt: 1, role: 'user', content: { type: 'text', text: 'hello' } },
                        { id: 'm2', createdAt: 2, role: 'user', content: { type: 'text', text: 'world' } },
                    ] },
                },
            });
        });

        expect(projectSpy).not.toHaveBeenCalled();
        expect(getCurrent().transcriptEntries).toHaveLength(0);
    });

    it('uses a fake second realtime provider global control scope without host edits', async () => {
        registerVoiceAdapters([createSurfaceAdapter('realtime_second_provider', 'global')]);
        const { useVoiceSurfaceConversationState } = await import('./useVoiceSurfaceConversationState');
        const { getCurrent } = await renderHook(() =>
            useVoiceSurfaceConversationState({
                providerId: 'realtime_second_provider',
                activeControlSessionId: null,
                surfaceSessionId: null,
                transcriptEnabled: false,
                voiceSettings: {},
            }),
        );

        expect(getCurrent().fallbackOpenConversationControlSessionId).toBe('voice-global');
        expect(resolveBindingSpy).toHaveBeenCalledWith({
            sessionId: 'voice-global',
            adapterId: 'realtime_second_provider',
        });
    });

    it('does not invent a global control session for a disabled provider', async () => {
        const { useVoiceSurfaceConversationState } = await import('./useVoiceSurfaceConversationState');
        const { getCurrent } = await renderHook(() =>
            useVoiceSurfaceConversationState({
                providerId: 'realtime_elevenlabs',
                activeControlSessionId: null,
                surfaceSessionId: null,
                transcriptEnabled: false,
                voiceSettings: {},
            }),
        );

        expect(getCurrent().fallbackOpenConversationControlSessionId).toBeNull();
        expect(resolveBindingSpy).not.toHaveBeenCalled();
    });
});

function createSurfaceAdapter(
    id: string,
    controlSessionScope: 'surface' | 'global',
): VoiceAdapterController {
    return {
        id,
        engineKind: 'realtime',
        start: async () => {},
        stop: async () => {},
        toggle: async () => {},
        interrupt: async () => {},
        setMuted: async () => {},
        sendContextUpdate: () => {},
        getSnapshot: () => ({ adapterId: id, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false }),
        resolveSurfaceCapabilities: () => ({
            allowsGlobalStart: controlSessionScope === 'global',
            controlSessionScope,
            requiresVoiceAgentFeature: false,
            bargeInEnabled: false,
        }),
    };
}
