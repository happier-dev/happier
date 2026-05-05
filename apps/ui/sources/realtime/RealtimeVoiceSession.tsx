import React, { useEffect, useMemo, useRef } from 'react';
import './elevenlabs/installElevenLabsNativeGlobals';
import '@elevenlabs/react-native';
import { realtimeClientTools } from './realtimeClientTools';
import { createElevenLabsConversationHandle } from '@/voice/adapters/realtimeElevenLabs/createElevenLabsConversationHandle';
import { realtimeTransport } from '@/voice/runtime/realtime/RealtimeTransport';
import { captureExceptionIfEnabled } from '@/utils/system/sentry';

export const RealtimeVoiceSession: React.FC = () => {
    const conversation = useMemo(() => createElevenLabsConversationHandle({
        clientTools: realtimeClientTools,
        callbacks: {
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
        },
    }), []);

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
        realtimeTransport.registerConversationHandle({ textOnly: false, handle: conversation });
        realtimeTransport.registerConversationHandle({ textOnly: true, handle: conversation });

        return () => {
            realtimeTransport.registerConversationHandle({ textOnly: false, handle: null });
            realtimeTransport.registerConversationHandle({ textOnly: true, handle: null });
            realtimeTransport.setActiveConversationHandle(null);
            conversation.dispose();
        };
    }, [conversation]);

    // This component doesn't render anything visible
    return null;
};
