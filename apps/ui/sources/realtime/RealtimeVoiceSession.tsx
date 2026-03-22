import React, { useEffect, useRef } from 'react';
import { useConversation } from '@elevenlabs/react-native';
import { getCurrentRealtimeControlSessionId, registerVoiceSession, setCurrentRealtimeControlSessionId } from './RealtimeSession';
import { storage } from '@/sync/domains/state/storage';
import { realtimeClientTools } from './realtimeClientTools';
import { getElevenLabsCodeFromPreference } from '@/constants/Languages';
import type { VoiceSession, VoiceSessionConfig } from './types';
import { useVoiceQaStore } from '@/voice/qa/voiceQaStore';
import { resolveVoiceSessionBindingByControlSessionId } from '@/voice/sessionBinding/resolveVoiceSessionBinding';
import { appendRealtimeVoiceTranscriptEvent } from './realtimeVoiceTranscriptBridge';

// Static reference to the conversation hook instance
type ElevenLabsConversation = Readonly<{
    startSession: (config: unknown) => Promise<unknown>;
    endSession: () => Promise<void>;
    getId: () => string | null;
    sendUserMessage: (message: string) => void;
    sendContextualUpdate: (update: string) => void;
}>;

// Treat this as a boundary to the third-party hook typing.
let conversationInstance: ElevenLabsConversation | null = null;

function debugLog(...args: unknown[]) {
    if (!__DEV__) return;
    console.debug(...args);
}

function getRealtimeVoiceErrorMessage(error: unknown): string {
    if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
        return error.message;
    }
    return 'realtime_voice_error';
}

// Global voice session implementation
class RealtimeVoiceSessionImpl implements VoiceSession {
    
    async startSession(config: VoiceSessionConfig): Promise<string | null> {
        if (!conversationInstance) {
            console.warn('Realtime voice session not initialized');
            throw new Error('Realtime voice session not initialized');
        }

        try {
            storage.getState().setRealtimeStatus('connecting');
            
            // Get user's preferred language for voice assistant
            const settings: any = storage.getState().settings;
            const voice = settings?.voice ?? null;
            const adapterLanguagePreference = voice?.adapters?.realtime_elevenlabs?.assistantLanguage ?? null;
            const userLanguagePreference = adapterLanguagePreference ?? voice?.assistantLanguage ?? null;
            const elevenLabsLanguage = getElevenLabsCodeFromPreference(userLanguagePreference);
            
            if (!config.token) {
                throw new Error('Missing conversation token');
            }
            
            const sessionConfig: any = {
                connectionType: 'webrtc',
                dynamicVariables: {
                    sessionId: config.sessionId,
                    initialConversationContext: config.initialContext || ''
                },
                overrides: {
                    conversation: {
                        textOnly: config.textOnly === true,
                    },
                    agent: {
                        language: elevenLabsLanguage
                    }
                },
                conversationToken: config.token,
            };
            
            const rawConversationId = await conversationInstance.startSession(sessionConfig);
            const conversationId =
                (typeof rawConversationId === 'string' && rawConversationId.trim().length > 0
                    ? rawConversationId
                    : (conversationInstance.getId() ?? null));
            if (typeof conversationId !== 'string' || conversationId.trim().length === 0) {
                return null;
            }
            setCurrentRealtimeControlSessionId(config.sessionId);
            return conversationId;
        } catch (error) {
            console.error('Failed to start realtime session:', error);
            storage.getState().setRealtimeStatus('error');
            throw error;
        }
    }

    async endSession(): Promise<void> {
        if (!conversationInstance) {
            return;
        }

        try {
            await conversationInstance.endSession();
            setCurrentRealtimeControlSessionId(null);
            storage.getState().setRealtimeStatus('disconnected');
        } catch (error) {
            console.error('Failed to end realtime session:', error);
        }
    }

    sendTextMessage(message: string): void {
        if (!conversationInstance) {
            console.warn('Realtime voice session not initialized');
            return;
        }

        try {
            conversationInstance.sendUserMessage(message);
        } catch (error) {
            console.error('Failed to send text message:', error);
        }
    }

    sendContextualUpdate(update: string): void {
        if (!conversationInstance) {
            console.warn('Realtime voice session not initialized');
            return;
        }

        try {
            conversationInstance.sendContextualUpdate(update);
        } catch (error) {
            console.error('Failed to send contextual update:', error);
        }
    }
}

export const RealtimeVoiceSession: React.FC = () => {
    const conversation = useConversation({
        clientTools: realtimeClientTools,
        onConnect: (data) => {
            debugLog('Realtime session connected');
            storage.getState().setRealtimeStatus('connected');
            storage.getState().setRealtimeMode('idle');
            useVoiceQaStore.getState().appendSystem('Realtime ElevenLabs session connected');
        },
        onDisconnect: () => {
            debugLog('Realtime session disconnected');
            storage.getState().setRealtimeStatus('disconnected');
            storage.getState().setRealtimeMode('idle', true); // immediate mode change
            storage.getState().clearRealtimeModeDebounce();
            useVoiceQaStore.getState().appendSystem('Realtime ElevenLabs session disconnected');
        },
        onMessage: (data) => {
            debugLog('Realtime message received');
            useVoiceQaStore.getState().appendRealtimeProviderPayload(data);
            const controlSessionId = getCurrentRealtimeControlSessionId();
            const binding = controlSessionId
                ? resolveVoiceSessionBindingByControlSessionId({ controlSessionId, adapterId: 'realtime_elevenlabs' })
                : null;
            appendRealtimeVoiceTranscriptEvent({
                conversationSessionId: binding?.conversationSessionId ?? null,
                payload: data,
            });
        },
        onError: (error) => {
            // Log but don't block app - voice features will be unavailable
            // This prevents initialization errors from showing "Terminals error" on startup
            console.warn('Realtime voice not available:', error);
            // Don't set error status during initialization - just set disconnected
            // This allows the app to continue working without voice features
            storage.getState().setRealtimeStatus('disconnected');
            storage.getState().setRealtimeMode('idle', true); // immediate mode change
            useVoiceQaStore.getState().appendError(getRealtimeVoiceErrorMessage(error));
        },
        onStatusChange: (data) => {
            debugLog('Realtime status change');
        },
        onModeChange: (data) => {
            debugLog('Realtime mode change');
            
            // Only animate when speaking
            const mode = data.mode as string;
            const isSpeaking = mode === 'speaking';
            
            // Use centralized debounce logic from storage
            storage.getState().setRealtimeMode(isSpeaking ? 'speaking' : 'idle');
        },
        onDebug: (message) => {
            debugLog('Realtime debug:', message);
        }
    });

    const hasRegistered = useRef(false);

    useEffect(() => {
        // Store the conversation instance globally
        conversationInstance = conversation as unknown as ElevenLabsConversation;

        // Register the voice session once
        if (!hasRegistered.current) {
            try {
                registerVoiceSession(new RealtimeVoiceSessionImpl());
                hasRegistered.current = true;
            } catch (error) {
                console.error('Failed to register voice session:', error);
            }
        }

        return () => {
            // Clean up on unmount
            conversationInstance = null;
        };
    }, [conversation]);

    // This component doesn't render anything visible
    return null;
};
