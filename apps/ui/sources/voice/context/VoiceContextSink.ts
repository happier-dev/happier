import type { VoiceHostAuthoredContextScope } from '@/voice/session/types';

export interface VoiceContextSink {
    /** Which host-authored context the active provider's execution authorizes. */
    hostAuthoredContext: VoiceHostAuthoredContextScope;
    sendContextualUpdate: (sessionId: string, update: string) => void;
    sendTextMessage: (sessionId: string, update: string) => void;
    announceAssistantText?: (sessionId: string, text: string) => void;
}
