export type VoiceConversationTranscriptMode = 'native_session' | 'synthetic';

export type VoiceSessionBinding = Readonly<{
  adapterId: string;
  controlSessionId: string;
  conversationSessionId: string;
  transcriptMode: VoiceConversationTranscriptMode;
  targetSessionId: string | null;
  updatedAt: number;
}>;

export type VoiceConversationBindingResolution = Readonly<{
  controlSessionId: string;
  conversationSessionId: string;
  transcriptMode: VoiceConversationTranscriptMode;
  targetSessionId: string | null;
}>;
