import { beforeEach, describe, expect, it, vi } from 'vitest';
// Compile the real host contract during collection rather than the timed SDK-loading probe.
import '@happier-dev/plugin-sdk/voice/client';

beforeEach(() => {
    vi.resetModules();
    vi.doUnmock('@elevenlabs/client');
});

describe('ElevenLabs browser SDK demand loading', () => {
    it('loads the media SDK only when a conversation starts and recovers after a failed start', async () => {
        let loaded = false;
        const conversation = {
            getId: () => 'conversation-one', endSession: vi.fn(async () => {}),
            setVolume: vi.fn(), setMicMuted: vi.fn(),
        };
        const startSession = vi.fn()
            .mockRejectedValueOnce(new Error('connection failed'))
            .mockResolvedValueOnce(conversation);
        // The third-party SDK owns browser media; all handle lifecycle logic stays real.
        vi.doMock('@elevenlabs/client', () => {
            loaded = true;
            return { Conversation: { startSession } };
        });
        const { createElevenLabsConversationHandle } = await import('./conversationHandle.js');
        const handle = createElevenLabsConversationHandle({ tools: [] });
        handle.setMicMuted(true);
        handle.setOutputVolume(0.18);
        expect(loaded).toBe(false);

        await expect(handle.startSession({ signedUrl: 'wss://voice.example.test' })).rejects.toThrow('connection failed');
        await expect(handle.startSession({ signedUrl: 'wss://voice.example.test' })).resolves.toBe('conversation-one');
        expect(conversation.setMicMuted).toHaveBeenCalledWith(true);
        expect(conversation.setVolume).toHaveBeenCalledWith({ volume: 0.18 });
        await handle.endSession();
        expect(conversation.endSession).toHaveBeenCalledOnce();
    });

    it('does not open browser media when disposal happens during SDK loading', async () => {
        let releaseSdk!: () => void;
        const ready = new Promise<void>((resolve) => { releaseSdk = resolve; });
        let notifyLoading!: () => void;
        const loading = new Promise<void>((resolve) => { notifyLoading = resolve; });
        const startSession = vi.fn();
        vi.doMock('@elevenlabs/client', async () => {
            notifyLoading();
            await ready;
            return { Conversation: { startSession } };
        });
        const handleModule = import('./conversationHandle.js');
        const firstBoundary = await Promise.race([
            handleModule.then(() => 'handle'),
            loading.then(() => 'sdk'),
        ]);
        if (firstBoundary === 'sdk') releaseSdk();
        expect(firstBoundary).toBe('handle');
        const { createElevenLabsConversationHandle } = await handleModule;
        const handle = createElevenLabsConversationHandle({ tools: [] });
        const started = handle.startSession({});
        await loading;
        handle.dispose();
        releaseSdk();
        await expect(started).resolves.toBeNull();
        expect(startSession).not.toHaveBeenCalled();
    });
});
