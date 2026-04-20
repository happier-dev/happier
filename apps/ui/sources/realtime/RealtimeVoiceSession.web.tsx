import React, { useEffect, useRef } from 'react';
import { useConversation } from '@elevenlabs/react';
import type { MessagePayload, Mode, Status } from '@elevenlabs/types';
import { realtimeClientTools } from './realtimeClientTools';
import { realtimeTransport, type RealtimeConversationHandle } from '@/voice/runtime/realtime/RealtimeTransport';
import { captureExceptionIfEnabled } from '@/utils/system/sentry';

function debugLog(...args: unknown[]) {
    if (!__DEV__) return;
    console.debug(...args);
}

export const RealtimeVoiceSession: React.FC = () => {
    const buildConversationOptions = (textOnly: boolean) => ({
        clientTools: realtimeClientTools,
        textOnly,
        onConnect: () => {
            debugLog('Realtime session connected');
            realtimeTransport.handleProviderConnected();
        },
        onDisconnect: () => {
            debugLog('Realtime session disconnected');
            realtimeTransport.handleProviderDisconnected();
        },
        onMessage: (data: MessagePayload) => {
            debugLog('Realtime message received');
            realtimeTransport.handleProviderMessage(data);
        },
        onError: (error: string) => {
            realtimeTransport.handleProviderError(error);
        },
        onStatusChange: (_data: { status: Status }) => {
            debugLog('Realtime status change');
        },
        onModeChange: (data: { mode: Mode }) => {
            debugLog('Realtime mode change');
            realtimeTransport.handleProviderModeChange(data.mode as string);
        },
        onDebug: () => {
            debugLog('Realtime debug');
        }
    });
    const voiceConversation = useConversation(buildConversationOptions(false));
    const textConversation = useConversation(buildConversationOptions(true));

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
                    platform: 'web',
                },
            });
        }

        return () => {
            // Only treat a real component unmount as the teardown boundary.
            realtimeTransport.handleProviderComponentUnmounted();
        };
    }, []);

    useEffect(() => {
        debugLog('[RealtimeVoiceSession] Setting conversationInstance');
        realtimeTransport.registerConversationHandle({
            textOnly: false,
            handle: voiceConversation as unknown as RealtimeConversationHandle,
        });
        realtimeTransport.registerConversationHandle({
            textOnly: true,
            handle: textConversation as unknown as RealtimeConversationHandle,
        });

        return () => {
            realtimeTransport.registerConversationHandle({ textOnly: false, handle: null });
            realtimeTransport.registerConversationHandle({ textOnly: true, handle: null });
            realtimeTransport.setActiveConversationHandle(null);
        };
    }, [voiceConversation, textConversation]);

    // This component doesn't render anything visible
    return null;
};
