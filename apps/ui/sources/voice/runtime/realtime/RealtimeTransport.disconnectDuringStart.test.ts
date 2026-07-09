import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RealtimeTransport } from './RealtimeTransport';

import type { VoiceSessionConfig } from '@/realtime/types';
import type { RealtimeTransportProvider } from './realtimeTransportProvider';
import type { MicSession } from '@/voice/runtime/mic/MicSession';

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((nextResolve, nextReject) => {
        resolve = nextResolve;
        reject = nextReject;
    });
    return { promise, resolve, reject };
}

describe('RealtimeTransport (disconnect during start)', () => {
    beforeEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('aborts an in-flight startRealtimeSession when provider disconnects, finalizing a late provider completion without reviving state', async () => {
        const startSessionCalled = createDeferred<void>();
        const startSessionDeferred = createDeferred<string>();

        const startSession = vi.fn(async (_config: VoiceSessionConfig) => {
            startSessionCalled.resolve();
            return startSessionDeferred.promise;
        });
        const endSession = vi.fn(async () => {});

        const voiceSession = {
            startSession,
            endSession,
            sendTextMessage: vi.fn(),
            sendContextualUpdate: vi.fn(),
        };

        const providerHandleSessionStarted = vi.fn();
        const providerHandleSessionEnded = vi.fn(async () => {});
        const provider: RealtimeTransportProvider = {
            adapterId: 'test_provider',
            buildConversationStartConfig: ({ config }) => config,
            handleProviderConnected: () => {},
            handleProviderDiagnosticsError: () => {},
            handleProviderDisconnected: () => {},
            handleProviderMessage: () => {},
            handleSessionEnded: providerHandleSessionEnded,
            handleSessionStarted: (args) => providerHandleSessionStarted(args),
            isSelectedProvider: () => true,
            prepareSessionStart: async ({ controlSessionId, textOnly }) => ({
                sessionConfig: {
                    sessionId: controlSessionId,
                    token: 'token_1',
                    textOnly,
                },
                sessionState: {
                    billingMode: 'happier',
                    expiresAtMs: null,
                    leaseId: null,
                },
            }),
            resetActiveSession: () => {},
            resolveConversationId: ({ rawConversationId }) => (typeof rawConversationId === 'string' ? rawConversationId : null),
            resolveProviderMode: () => 'idle',
        };

        const micSession: MicSession = {
            ensureActive: vi.fn(async () => {}),
            setMuted: vi.fn(),
            isMuted: () => false,
            teardown: vi.fn(async () => {}),
            getStream: () => null,
        };

        const enableAudioMode = vi.fn(async () => {});
        const disableAudioMode = vi.fn(async () => {});
        const ensureBound = vi.fn(async () => {});

        const transport = new RealtimeTransport(provider, {
            createMicSession: () => micSession,
            getSettings: () => ({}),
            getStorageState: () =>
                ({
                    settings: {},
                    setRealtimeStatus: () => {},
                    setRealtimeMode: () => {},
                    clearRealtimeModeDebounce: () => {},
                }) as any,
            ensureBound,
            applyVoiceSessionTargetSelection: () => {},
            enableVoiceBackgroundCallAudioMode: enableAudioMode,
            disableVoiceBackgroundCallAudioMode: disableAudioMode,
            now: () => 0,
        });
        transport.registerVoiceSession(voiceSession);

        const startPromise = transport.startRealtimeSession('s1');
        await startSessionCalled.promise;

        transport.handleProviderDisconnected();
        startSessionDeferred.resolve('conv_1');
        await startPromise;

        expect(providerHandleSessionStarted).toHaveBeenCalledTimes(1);
        expect(providerHandleSessionEnded).toHaveBeenCalled();
        expect(transport.isVoiceSessionStarted()).toBe(false);
        expect(transport.getCurrentRealtimeControlSessionId()).toBeNull();
        expect(endSession).toHaveBeenCalledTimes(1);
        expect(disableAudioMode).toHaveBeenCalledTimes(1);
    });
});
