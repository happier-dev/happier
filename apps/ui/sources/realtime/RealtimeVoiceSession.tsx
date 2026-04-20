import React, { useEffect, useRef } from 'react';
import { ElevenLabsProvider, useConversation } from '@elevenlabs/react-native';
import { realtimeClientTools } from './realtimeClientTools';
import { realtimeTransport, type RealtimeConversationHandle } from '@/voice/runtime/realtime/RealtimeTransport';
import { captureExceptionIfEnabled } from '@/utils/system/sentry';

const RealtimeVoiceSessionInner: React.FC = () => {
    const conversation = useConversation({
        clientTools: realtimeClientTools,
        onConnect: () => {
            realtimeTransport.handleProviderConnected();
        },
        onDisconnect: () => {
            realtimeTransport.handleProviderDisconnected();
        },
        onMessage: (data) => {
            realtimeTransport.handleProviderMessage(data);
        },
        onError: (error) => {
            realtimeTransport.handleProviderError(error);
        },
        onStatusChange: () => {},
        onModeChange: (data) => {
            realtimeTransport.handleProviderModeChange(data.mode as string);
        },
        onDebug: () => {},
    });

    const hasRegistered = useRef(false);

    useEffect(() => {
        // Register the voice session once for the lifetime of this mounted component.
        // NOTE: do not tie this to conversation handle identity; the provider hook may replace handles
        // without the component actually unmounting.
        if (hasRegistered.current) {
            return;
        }
        try {
            realtimeTransport.registerVoiceSession(realtimeTransport.getConversationBackedVoiceSession());
            hasRegistered.current = true;
        } catch (error) {
            captureExceptionIfEnabled(error, {
                tags: {
                    area: 'realtime_voice_session',
                    platform: 'native',
                },
            });
        }

        return () => {
            // Only treat a real component unmount as the teardown boundary.
            realtimeTransport.handleProviderComponentUnmounted();
        };
    }, []);

    useEffect(() => {
        realtimeTransport.registerConversationHandle({
            textOnly: false,
            handle: conversation as unknown as RealtimeConversationHandle,
        });

        return () => {
            realtimeTransport.registerConversationHandle({ textOnly: false, handle: null });
            realtimeTransport.setActiveConversationHandle(null);
        };
    }, [conversation]);

    // This component doesn't render anything visible
    return null;
};

export const RealtimeVoiceSession: React.FC = () => (
    <ElevenLabsProvider>
        <RealtimeVoiceSessionInner />
    </ElevenLabsProvider>
);
