export type VoiceConversationTranscriptMode = 'native_session' | 'synthetic';

export type VoiceSessionBinding = Readonly<{
    adapterId: string;
    controlSessionId: string;
    conversationSessionId: string;
    runId?: string | null;
    streamId?: string | null;
    transcriptMode: VoiceConversationTranscriptMode;
    targetSessionId: string | null;
    updatedAt: number;
}>;

export type VoiceConversationBindingResolution = Readonly<{
    controlSessionId: string;
    conversationSessionId: string;
    runId?: string | null;
    streamId?: string | null;
    transcriptMode: VoiceConversationTranscriptMode;
    targetSessionId: string | null;
}>;
