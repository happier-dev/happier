import { beforeEach, describe, expect, it, vi } from 'vitest';
// Compile the real host contract during collection rather than the timed SDK-loading probe.
import '@happier-dev/plugin-sdk/voice/client';
import { createElevenLabsConversationHandle } from './conversationHandle.js';

const platform = vi.hoisted(() => ({ OS: 'web' }));
vi.mock('react-native', () => ({ Platform: platform }));

beforeEach(() => {
    platform.OS = 'web';
    vi.resetModules();
    vi.doUnmock('@elevenlabs/client');
    vi.doUnmock('@elevenlabs/client/internal');
});

describe('ElevenLabs browser SDK demand loading', () => {
    it('retires a native start during strategy loading before opening any media', async () => {
        platform.OS = 'ios';
        let release!: () => void;
        const ready = new Promise<void>((resolve) => { release = resolve; });
        let notifyLoading!: () => void;
        const loading = new Promise<void>((resolve) => { notifyLoading = resolve; });
        const setSetupStrategy = vi.fn();
        const startSession = vi.fn();
        vi.doMock('@elevenlabs/client/internal', async () => {
            notifyLoading();
            await ready;
            return { setSetupStrategy, createConnection: vi.fn(), setupWebRTCSession: vi.fn() };
        });
        vi.doMock('@elevenlabs/client', () => ({ Conversation: { startSession } }));
        const handle = createElevenLabsConversationHandle({ tools: [], loadConversationSdk: () => import('@elevenlabs/client') });
        const started = handle.startSession({});
        await loading;
        handle.dispose();
        release();
        await expect(started).resolves.toBeNull();
        expect(setSetupStrategy).not.toHaveBeenCalled();
        expect(startSession).not.toHaveBeenCalled();
    });

    it.each(['web', 'ios', 'android'])('loads the %s SDK strategy only at conversation start', async (os) => {
        platform.OS = os;
        let nativeLoaded = false;
        let installedStrategy: ((options: unknown) => Promise<unknown>) | undefined;
        const media = { kind: 'admitted-webrtc-media' };
        const connection = { kind: 'provider-connection' };
        vi.doMock('@elevenlabs/client/internal', () => {
            nativeLoaded = true;
            return {
                setSetupStrategy(strategy: typeof installedStrategy) { installedStrategy = strategy; },
                createConnection: async () => connection,
                setupWebRTCSession: () => media,
            };
        });
        const startSession = vi.fn(async () => {
            if (os !== 'web') {
                expect(installedStrategy).toBeTypeOf('function');
                expect(await installedStrategy!({ connectionType: 'webrtc' })).toBe(media);
            }
            return { getId: () => 'portable-conversation', endSession: async () => {} };
        });
        vi.doMock('@elevenlabs/client', () => ({ Conversation: { startSession } }));
        const handle = createElevenLabsConversationHandle({ tools: [], loadConversationSdk: () => import('@elevenlabs/client') });
        expect(nativeLoaded).toBe(false);
        expect(await handle.startSession({ connectionType: 'webrtc' })).toBe('portable-conversation');
        expect(nativeLoaded).toBe(os !== 'web');
        await handle.endSession();
    });

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
        const handle = createElevenLabsConversationHandle({ tools: [], loadConversationSdk: () => import('@elevenlabs/client') });
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
        const handle = createElevenLabsConversationHandle({ tools: [], loadConversationSdk: () => import('@elevenlabs/client') });
        const started = handle.startSession({});
        await loading;
        handle.dispose();
        releaseSdk();
        await expect(started).resolves.toBeNull();
        expect(startSession).not.toHaveBeenCalled();
    });
});
