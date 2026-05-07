import React, { useEffect, useRef } from 'react';
import './elevenlabs/installElevenLabsNativeGlobals';
import '@elevenlabs/react-native';
import { Conversation } from '@elevenlabs/client';
import type {
    Callbacks,
    Conversation as ElevenLabsConversation,
    Mode,
    PartialOptions,
    Status,
} from '@elevenlabs/client';
import { getCurrentRealtimeControlSessionId, registerVoiceSession, setCurrentRealtimeControlSessionId } from './RealtimeSession';
import { storage } from '@/sync/domains/state/storage';
import { realtimeClientTools } from './realtimeClientTools';
import { getElevenLabsCodeFromPreference } from '@/constants/Languages';
import type { VoiceSession, VoiceSessionConfig } from './types';
import { useVoiceQaStore } from '@/voice/qa/voiceQaStore';
import { resolveVoiceSessionBindingByControlSessionId } from '@/voice/sessionBinding/resolveVoiceSessionBinding';
import { appendRealtimeVoiceTranscriptEvent } from './realtimeVoiceTranscriptBridge';

type MessagePayload = Parameters<NonNullable<Callbacks['onMessage']>>[0];
type RealtimeConversationOptions =
    Pick<PartialOptions, 'clientTools' | 'dynamicVariables' | 'overrides' | 'textOnly'>
    & Partial<Callbacks>;

let activeConversationInstance: ElevenLabsConversation | null = null;
let realtimeVoiceSessionMounted = false;
let latestStartSequence = 0;

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

function isCurrentStartSequence(startSequence: number): boolean {
    return realtimeVoiceSessionMounted && startSequence === latestStartSequence;
}

async function endSupersededConversation(conversation: ElevenLabsConversation): Promise<void> {
    try {
        await conversation.endSession();
    } catch (error) {
        console.warn('Failed to end superseded realtime session:', error);
    }
}

function buildConversationOptions(startSequence: number): RealtimeConversationOptions {
    return {
        clientTools: realtimeClientTools,
        onConnect: () => {
            if (!isCurrentStartSequence(startSequence)) return;
            debugLog('Realtime session connected');
            storage.getState().setRealtimeStatus('connected');
            storage.getState().setRealtimeMode('idle');
            useVoiceQaStore.getState().appendSystem('Realtime ElevenLabs session connected');
        },
        onDisconnect: () => {
            if (!isCurrentStartSequence(startSequence)) return;
            debugLog('Realtime session disconnected');
            storage.getState().setRealtimeStatus('disconnected');
            storage.getState().setRealtimeMode('idle', true); // immediate mode change
            storage.getState().clearRealtimeModeDebounce();
            activeConversationInstance = null;
            setCurrentRealtimeControlSessionId(null);
            useVoiceQaStore.getState().appendSystem('Realtime ElevenLabs session disconnected');
        },
        onMessage: (data: MessagePayload) => {
            if (!isCurrentStartSequence(startSequence)) return;
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
            if (!isCurrentStartSequence(startSequence)) return;
            // Log but don't block app - voice features will be unavailable
            // This prevents initialization errors from showing "Terminals error" on startup
            console.warn('Realtime voice not available:', error);
            // Don't set error status during initialization - just set disconnected
            // This allows the app to continue working without voice features
            storage.getState().setRealtimeStatus('disconnected');
            storage.getState().setRealtimeMode('idle', true); // immediate mode change
            useVoiceQaStore.getState().appendError(getRealtimeVoiceErrorMessage(error));
        },
        onStatusChange: (_data: { status: Status }) => {
            if (!isCurrentStartSequence(startSequence)) return;
            debugLog('Realtime status change');
        },
        onModeChange: (data: { mode: Mode }) => {
            if (!isCurrentStartSequence(startSequence)) return;
            debugLog('Realtime mode change');

            // Only animate when speaking
            const mode = data.mode as string;
            const isSpeaking = mode === 'speaking';

            // Use centralized debounce logic from storage
            storage.getState().setRealtimeMode(isSpeaking ? 'speaking' : 'idle');
        },
        onDebug: (message) => {
            if (!isCurrentStartSequence(startSequence)) return;
            debugLog('Realtime debug:', message);
        }
    };
}

// Global voice session implementation
class RealtimeVoiceSessionImpl implements VoiceSession {
    
    async startSession(config: VoiceSessionConfig): Promise<string | null> {
        if (!realtimeVoiceSessionMounted) {
            console.warn('Realtime voice session not initialized');
            throw new Error('Realtime voice session not initialized');
        }

        try {
            storage.getState().setRealtimeStatus('connecting');
            
            // Get user's preferred language for voice assistant
            const startSequence = ++latestStartSequence;
            const wantsTextOnly = config.textOnly === true;
            const settings: any = storage.getState().settings;
            const voice = settings?.voice ?? null;
            const adapterLanguagePreference = voice?.adapters?.realtime_elevenlabs?.assistantLanguage ?? null;
            const userLanguagePreference = adapterLanguagePreference ?? voice?.assistantLanguage ?? null;
            const elevenLabsLanguage = getElevenLabsCodeFromPreference(userLanguagePreference);
            const useSignedWebsocket = wantsTextOnly && typeof config.signedUrl === 'string' && config.signedUrl.trim().length > 0;
            const baseSessionConfig: RealtimeConversationOptions = {
                ...buildConversationOptions(startSequence),
                dynamicVariables: {
                    sessionId: config.sessionId,
                    initialConversationContext: config.initialContext || '',
                },
                overrides: {
                    conversation: {
                        textOnly: wantsTextOnly,
                    },
                    agent: {
                        language: elevenLabsLanguage,
                    },
                },
                textOnly: wantsTextOnly,
            };
            const sessionConfig: PartialOptions = useSignedWebsocket
                ? {
                    ...baseSessionConfig,
                    connectionType: 'websocket',
                    signedUrl: config.signedUrl as string,
                }
                : {
                    ...baseSessionConfig,
                    connectionType: 'webrtc',
                    conversationToken: (() => {
                        if (typeof config.token === 'string' && config.token.trim().length > 0) {
                            return config.token;
                        }
                        throw new Error('Missing conversation token');
                    })(),
                };
            
            const conversation = await Conversation.startSession(sessionConfig);
            if (!isCurrentStartSequence(startSequence)) {
                await endSupersededConversation(conversation);
                return null;
            }

            const conversationId = conversation.getId();
            if (typeof conversationId !== 'string' || conversationId.trim().length === 0) {
                await endSupersededConversation(conversation);
                return null;
            }
            activeConversationInstance = conversation;
            setCurrentRealtimeControlSessionId(config.sessionId);
            return conversationId;
        } catch (error) {
            console.error('Failed to start realtime session:', error);
            storage.getState().setRealtimeStatus('error');
            throw error;
        }
    }

    async endSession(): Promise<void> {
        latestStartSequence += 1;
        const conversation = activeConversationInstance;
        if (!conversation) {
            return;
        }

        try {
            await conversation.endSession();
            activeConversationInstance = null;
            setCurrentRealtimeControlSessionId(null);
            storage.getState().setRealtimeStatus('disconnected');
        } catch (error) {
            console.error('Failed to end realtime session:', error);
        }
    }

    sendTextMessage(message: string): void {
        const conversation = activeConversationInstance;
        if (!conversation) {
            console.warn('Realtime voice session not initialized');
            return;
        }

        try {
            conversation.sendUserMessage(message);
        } catch (error) {
            console.error('Failed to send text message:', error);
        }
    }

    sendContextualUpdate(update: string): void {
        const conversation = activeConversationInstance;
        if (!conversation) {
            console.warn('Realtime voice session not initialized');
            return;
        }

        try {
            conversation.sendContextualUpdate(update);
        } catch (error) {
            console.error('Failed to send contextual update:', error);
        }
    }
}

export const RealtimeVoiceSession: React.FC = () => {

    const hasRegistered = useRef(false);

    useEffect(() => {
        realtimeVoiceSessionMounted = true;

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
            realtimeVoiceSessionMounted = false;
            latestStartSequence += 1;
            activeConversationInstance = null;
        };
    }, []);

    // This component doesn't render anything visible
    return null;
};
