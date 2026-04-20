import { beforeEach, describe, expect, it, vi } from 'vitest';

const adapterSendTextTurn = vi.fn(async () => {});
const adapterGet = vi.fn((_adapterId: string) => ({
    sendTextTurn: adapterSendTextTurn,
}));
const getVoiceSession = vi.fn(() => ({ sendTextMessage: vi.fn() }));
const isVoiceSessionStarted = vi.fn(() => false);
const appendVoiceConversationUserText = vi.fn();
vi.mock('@/voice/session/voiceAdapterRegistry', () => ({
    getVoiceAdapterRegistry: () => ({
        get: (adapterId: string) => adapterGet(adapterId),
    }),
}));

vi.mock('@/voice/runtime/realtime/RealtimeTransport', () => ({
    realtimeTransport: {
        getVoiceSession: () => getVoiceSession(),
        isVoiceSessionStarted: () => isVoiceSessionStarted(),
        startRealtimeSession: vi.fn(async () => {}),
        stopRealtimeSession: vi.fn(async () => {}),
    },
}));

vi.mock('@/voice/transcript/voiceConversationTranscript', () => ({
    appendVoiceConversationUserText: (params: unknown) => appendVoiceConversationUserText(params),
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        storage: {
            getState: () => ({
                settings: {},
            }),
        } as any,
    });
});

describe('createDefaultVoiceQaControllerDeps', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('routes realtime text sends through the realtime adapter so auto-start recovery stays intact', async () => {
        const { createDefaultVoiceQaControllerDeps } = await import('./voiceQaRuntimeDeps');
        const deps = createDefaultVoiceQaControllerDeps();

        await deps.sendRealtimeTextTurn({
            controlSessionId: 'voice-global',
            conversationSessionId: 'carrier-s1',
            text: 'hello',
        });

        expect(adapterGet).toHaveBeenCalledWith('realtime_elevenlabs');
        expect(adapterSendTextTurn).toHaveBeenCalledWith({
            controlSessionId: 'voice-global',
            conversationSessionId: 'carrier-s1',
            text: 'hello',
        });
        expect(appendVoiceConversationUserText).not.toHaveBeenCalled();
    });
});
