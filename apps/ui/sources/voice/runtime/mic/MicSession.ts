import type { VoiceMachineErrorKind } from '@/voice/runtime/machine/voiceConversationRuntimeTypes';

// A mic session can fail for any reason in the canonical voice error taxonomy
// (permission loss, transport/provider faults, plateau, etc.), so its failure
// kind is the full machine-error taxonomy rather than a hand-maintained subset.
export type MicSessionFailureKind = VoiceMachineErrorKind;

export type MicSessionFailure = Readonly<{
    kind: MicSessionFailureKind;
    reason: string;
}>;

export type CreateMicSessionOptions = Readonly<{
    onFailure?: (failure: MicSessionFailure) => void;
    /**
     * Continuous capture amplitude in [0,1], emitted while the mic is active so a
     * level visualizer can animate. Driven by the platform mic owner (web: an
     * AnalyserNode RMS loop) and reset to 0 on teardown. Consumers must route this
     * onto the UI-thread `voiceLevelShared` SharedValue, never React state.
     */
    onLevel?: (level: number) => void;
}>;

export type MicSession = Readonly<{
    ensureActive: () => Promise<void>;
    setMuted: (muted: boolean) => void;
    isMuted: () => boolean;
    teardown: () => Promise<void>;
    getStream: () => MediaStream | null;
    /**
     * The capture-owned {@link AudioContext}, when the platform implementation
     * owns one (web). Shared so a single context drives capture and downstream
     * consumers (e.g. WebVAD) instead of each opening its own. Native/recording
     * sessions return `null`.
     */
    getAudioContext?: () => AudioContext | null;
}>;
