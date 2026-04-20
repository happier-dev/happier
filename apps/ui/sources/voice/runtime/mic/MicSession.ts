export type MicSessionFailureKind = 'mic_ended' | 'audio_context_suspended';

export type MicSessionFailure = Readonly<{
    kind: MicSessionFailureKind;
    reason: string;
}>;

export type CreateMicSessionOptions = Readonly<{
    onFailure?: (failure: MicSessionFailure) => void;
}>;

export type MicSession = Readonly<{
    ensureActive: () => Promise<void>;
    setMuted: (muted: boolean) => void;
    isMuted: () => boolean;
    teardown: () => Promise<void>;
    getStream: () => MediaStream | null;
}>;
