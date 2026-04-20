import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RealtimeTransport } from './RealtimeTransport';
import { voiceConversationRuntimeMachine } from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';
import { getVoiceConversationRuntimeSnapshot } from '@/voice/runtime/machine/voiceConversationRuntimeStore';

import type { MicSession } from '@/voice/runtime/mic/MicSession';
import type { RealtimeTransportProvider } from './realtimeTransportProvider';

describe('RealtimeTransport (stop lifecycle)', () => {
    beforeEach(() => {
        voiceConversationRuntimeMachine.reset();
    });

    it('transitions the runtime machine to disconnected after stopRealtimeSession even if the provider never emits disconnected', async () => {
        const provider: RealtimeTransportProvider = {
            adapterId: 'test_provider',
            buildConversationStartConfig: ({ config }) => config,
            handleProviderConnected: () => {},
            handleProviderDiagnosticsError: () => {},
            handleProviderDisconnected: () => {},
            handleProviderMessage: () => {},
            handleSessionEnded: async () => {},
            handleSessionStarted: () => {},
            isSelectedProvider: () => true,
            prepareSessionStart: async () => null,
            resetActiveSession: () => {},
            resolveConversationId: () => null,
            resolveProviderMode: () => 'idle',
        };

        const micSession: MicSession = {
            ensureActive: vi.fn(async () => {}),
            setMuted: vi.fn(),
            isMuted: () => false,
            teardown: vi.fn(async () => {}),
            getStream: () => null,
        };

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
            ensureBound: async () => {},
            applyVoiceSessionTargetSelection: () => {},
            enableVoiceBackgroundCallAudioMode: async () => {},
            disableVoiceBackgroundCallAudioMode: async () => {},
        });
        transport.registerVoiceSession({
            startSession: vi.fn(async () => 'conv_1'),
            endSession: vi.fn(async () => {}),
            sendTextMessage: vi.fn(),
            sendContextualUpdate: vi.fn(),
        });

        transport.setCurrentRealtimeControlSessionId('s1');
        await transport.stopRealtimeSession();

        expect(getVoiceConversationRuntimeSnapshot()).toMatchObject({
            controlSessionId: 's1',
            state: 'disconnected',
            error: null,
        });
    });
});
