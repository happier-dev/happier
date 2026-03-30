import React, { useEffect, useRef } from 'react';
import { useConversation } from '@elevenlabs/react';
import type { MessagePayload, Mode, Status } from '@elevenlabs/types';
import { getCurrentRealtimeControlSessionId, registerVoiceSession, setCurrentRealtimeControlSessionId } from './RealtimeSession';
import { storage } from '@/sync/domains/state/storage';
import { realtimeClientTools } from './realtimeClientTools';
import { getElevenLabsCodeFromPreference } from '@/constants/Languages';
import type { VoiceSession, VoiceSessionConfig } from './types';
import { useVoiceQaStore } from '@/voice/qa/voiceQaStore';
import { resolveVoiceSessionBindingByControlSessionId } from '@/voice/sessionBinding/resolveVoiceSessionBinding';
import { appendRealtimeVoiceTranscriptEvent } from './realtimeVoiceTranscriptBridge';

// Static references to the conversation hook instances
let voiceConversationInstance: ReturnType<typeof useConversation> | null = null;
let textConversationInstance: ReturnType<typeof useConversation> | null = null;
let activeConversationInstance: ReturnType<typeof useConversation> | null = null;
const CONVERSATION_INSTANCE_READY_TIMEOUT_MS = 500;

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

function resolveConversationInstance(textOnly: boolean): ReturnType<typeof useConversation> | null {
    return textOnly ? textConversationInstance : voiceConversationInstance;
}

async function waitForConversationInstanceReady(
    textOnly: boolean,
    timeoutMs: number,
): Promise<ReturnType<typeof useConversation> | null> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const readyConversation = resolveConversationInstance(textOnly);
        if (readyConversation) return readyConversation;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return resolveConversationInstance(textOnly);
}

// Global voice session implementation
class RealtimeVoiceSessionImpl implements VoiceSession {

    async startSession(config: VoiceSessionConfig): Promise<string | null> {
        debugLog('[RealtimeVoiceSessionImpl] startSession');
        const wantsTextOnly = config.textOnly === true;
        const readyConversation =
            resolveConversationInstance(wantsTextOnly)
            ?? await waitForConversationInstanceReady(wantsTextOnly, CONVERSATION_INSTANCE_READY_TIMEOUT_MS);
        if (!readyConversation) {
            console.warn('Realtime voice session not initialized - conversationInstance is null');
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
            
            const useSignedWebsocket = wantsTextOnly && typeof config.signedUrl === 'string' && config.signedUrl.trim().length > 0;
            if (!useSignedWebsocket && !config.token) {
                throw new Error('Missing conversation token');
            }
            
            const sessionConfig: any = {
                connectionType: useSignedWebsocket ? 'websocket' : 'webrtc',
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
            };
            if (useSignedWebsocket) {
                sessionConfig.signedUrl = config.signedUrl;
            } else {
                sessionConfig.conversationToken = config.token;
            }
            
            const rawConversationId = await readyConversation.startSession(sessionConfig);
            const conversationId =
                (typeof rawConversationId === 'string' && rawConversationId.trim().length > 0
                    ? rawConversationId
                    : (readyConversation.getId() ?? null));
            if (typeof conversationId !== 'string' || conversationId.trim().length === 0) {
                debugLog('[RealtimeVoiceSessionImpl] startSession returned no valid conversationId', {
                    rawConversationId,
                    fallbackConversationId: readyConversation.getId?.(),
                });
                return null;
            }

            debugLog('Started conversation');
            activeConversationInstance = readyConversation;
            setCurrentRealtimeControlSessionId(config.sessionId);
            return conversationId;
        } catch (error) {
            console.error('Failed to start realtime session:', error);
            storage.getState().setRealtimeStatus('error');
            throw error;
        }
    }

    async endSession(): Promise<void> {
        const conversation = activeConversationInstance ?? voiceConversationInstance ?? textConversationInstance;
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
        const conversation = activeConversationInstance ?? textConversationInstance ?? voiceConversationInstance;
        if (!conversation) {
            console.warn('Realtime voice session not initialized');
            return;
        }

        conversation.sendUserMessage(message);
    }

    sendContextualUpdate(update: string): void {
        const conversation = activeConversationInstance ?? textConversationInstance ?? voiceConversationInstance;
        if (!conversation) {
            console.warn('Realtime voice session not initialized');
            return;
        }

        conversation.sendContextualUpdate(update);
    }
}

export const RealtimeVoiceSession: React.FC = () => {
    const buildConversationOptions = (textOnly: boolean) => ({
        clientTools: realtimeClientTools,
        textOnly,
        onConnect: () => {
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
        onMessage: (data: MessagePayload) => {
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
        onError: (error: string) => {
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
            debugLog('Realtime status change');
        },
        onModeChange: (data: { mode: Mode }) => {
            debugLog('Realtime mode change');
            
            // Only animate when speaking
            const mode = data.mode as string;
            const isSpeaking = mode === 'speaking';
            
            // Use centralized debounce logic from storage
            storage.getState().setRealtimeMode(isSpeaking ? 'speaking' : 'idle');
        },
        onDebug: (message: unknown) => {
            debugLog('Realtime debug:', message);
        }
    });
    const voiceConversation = useConversation(buildConversationOptions(false));
    const textConversation = useConversation(buildConversationOptions(true));

    const hasRegistered = useRef(false);

    useEffect(() => {
        debugLog('[RealtimeVoiceSession] Setting conversationInstance');
        voiceConversationInstance = voiceConversation;
        textConversationInstance = textConversation;

        // Register the voice session once
        if (!hasRegistered.current) {
            try {
                debugLog('[RealtimeVoiceSession] Registering voice session');
                registerVoiceSession(new RealtimeVoiceSessionImpl());
                hasRegistered.current = true;
                debugLog('[RealtimeVoiceSession] Voice session registered successfully');
            } catch (error) {
                console.error('Failed to register voice session:', error);
            }
        }

        return () => {
            // Clean up on unmount
            voiceConversationInstance = null;
            textConversationInstance = null;
            activeConversationInstance = null;
        };
    }, [voiceConversation, textConversation]);

    // This component doesn't render anything visible
    return null;
};
