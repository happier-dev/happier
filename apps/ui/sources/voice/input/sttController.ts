import type { VoiceMachineError } from '@/voice/runtime/machine/voiceMachineError';
import type { MicSession } from '@/voice/runtime/mic/MicSession';

/**
 * Why a captured turn ended. `silence`/`vad` are endpoint detections,
 * `manual` is a user/runtime stop, and `max_duration` is a hard cap. Lane 2/3
 * implementations may extend this union as richer endpointing lands.
 */
export type SttEndpointReason = 'silence' | 'vad' | 'manual' | 'max_duration';

/**
 * Streaming capture callbacks. A controller drives these as audio is captured
 * and transcribed:
 * - `onAudioStarted` — the capture source produced its first audio (clears
 *   silent-failure watchdogs and enables speculative routing).
 * - `onPartial` — interim, non-final transcript text (may be revised).
 * - `onFinal` — the committed transcript for the current turn.
 * - `onEndpoint` — the turn boundary was detected, with its reason.
 * - `onError` — a typed boundary failure (already classified).
 */
export type SttSink = Readonly<{
    onAudioStarted: () => void;
    onPartial: (text: string) => void;
    onFinal: (text: string) => void;
    onEndpoint: (reason: SttEndpointReason) => void;
    onError: (error: VoiceMachineError) => void;
}>;

export type SttStartParams = Readonly<{
    /** Active user-visible control session; privacy and diagnostics use this identity, never a routing session. */
    sessionId?: string;
    /** The single, already-acquired capture stream owner for this turn. */
    micSession: MicSession;
    /** Streaming callbacks the controller emits into. */
    sink: SttSink;
    /** Aborts in-flight capture/transcription work. */
    signal?: AbortSignal;
    /** Product capture purpose used by the aggregate native audio-session owner. */
    capturePurpose?: 'dictation' | 'conversation';
}>;

export type SttStopResult =
    | Readonly<{
        finalText: string;
    }>
    | Readonly<{
        error: VoiceMachineError;
    }>;

/**
 * Unified speech-to-text capture contract. Every STT path (device, sherpa,
 * HTTP one-shot, daemon) converges on this seam: it consumes the canonical
 * {@link MicSession}, streams results through an {@link SttSink}, honors an
 * abort `signal`, and returns either a truthfully finalized transcript or a
 * typed terminal failure on `stop()`. Interim text is never a final result.
 *
 * Interface-only contract — concrete controllers are implemented in Lane 2.
 */
export type SttController = Readonly<{
    start: (params: SttStartParams) => Promise<void>;
    stop: () => Promise<SttStopResult>;
}>;
