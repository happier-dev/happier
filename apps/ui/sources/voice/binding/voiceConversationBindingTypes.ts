import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

export type VoiceConversationTranscriptMode = 'native_session' | 'synthetic';

/** Person-selected conversation identity, carried with Start rather than saved as a preference. */
export type VoiceConversationSelection =
    | Readonly<{ kind: 'new'; creationKey: string }>
    | Readonly<{ kind: 'continue'; conversationSessionAddress: SessionAddress }>;

export type VoiceSessionBinding = Readonly<{
    adapterId: string;
    controlSessionId: string;
    conversationSessionId: string;
    conversationSessionAddress: SessionAddress;
    lifetime?: 'runtime_attempt';
    transcriptMode: VoiceConversationTranscriptMode;
    targetSessionAddress: SessionAddress | null;
    updatedAt: number;
}>;

export type VoiceConversationBindingResolution = Readonly<{
    controlSessionId: string;
    conversationSessionId: string;
    conversationSessionAddress: SessionAddress;
    transcriptMode: VoiceConversationTranscriptMode;
    targetSessionAddress: SessionAddress | null;
}>;
