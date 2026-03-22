export interface VoiceContextSink {
    sendContextualUpdate: (sessionId: string, update: string) => void;
    sendTextMessage: (sessionId: string, update: string) => void;
    announceAssistantText?: (sessionId: string, text: string) => void;
}
