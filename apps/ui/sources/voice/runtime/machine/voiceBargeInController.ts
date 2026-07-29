import {
    DEFAULT_ADAPTIVE_INTERRUPTION_IGNORED_PHRASES,
    resolveBackchannelDecision,
    type AdaptiveInterruptionConfig,
} from '@/voice/runtime/input/resolveBackchannelDecision';
import {
    createTextualEchoGuard,
    type TextualEchoDecision,
    type TextualEchoGuard,
} from '@/voice/runtime/echo/textualEchoGuard';
import type { TurnEndpointSignalSource } from '@/voice/runtime/input/TurnEndpointController';
import {
    turnTakingTelemetry as defaultTurnTakingTelemetry,
    type TurnTakingTelemetry,
    type TurnTakingTelemetrySuppressionReason,
} from '@/voice/input/turnTakingTelemetry';

import type { VoiceConversationRuntimeMachine } from './VoiceConversationRuntimeMachine';
import type {
    VoicePlaybackInterruptionMode,
    VoicePlaybackInterruptionResolution,
} from '@/voice/runtime/playback/VoicePlaybackController';
import { VOICE_RUNTIME_CONFIG_DEFAULTS } from '@/voice/runtime/voiceRuntimeConfigDefaults';

/**
 * Automatic VAD-driven barge-in trigger (L3.T4) — the SINGLE owner of the
 * "user spoke over the assistant" -> interrupt decision for the local path.
 *
 * The T1-T3 turn-taking DECISIONS already exist and are reused verbatim here;
 * this controller only WIRES them into real behavior:
 *
 *  1. Protected-head + backchannel gate (T2): `resolveBackchannelDecision`,
 *     passed the agent's `speakingElapsedMs` so the first window is
 *     non-interruptible, exact acknowledgement phrases never yield the floor,
 *     and measured-brief short utterances are treated as backchannels.
 *  2. Textual echo guard (T3): `createTextualEchoGuard`, so a candidate that is
 *     really the agent hearing its own TTS is dropped.
 *  3. Machine transition: only when the candidate survives both gates AND the
 *     machine is actually `speaking` for the requesting session do we abort TTS
 *     playback and drive the machine through its EXISTING public
 *     `interruptAndRearmListening` API (which enforces the legal transition
 *     table: speaking -> interrupted -> acquiring_mic -> listening).
 *
 * Playback abort is injected (`abortPlayback`) rather than reaching into the TTS
 * controller, so this module stays provider-agnostic and does not edit
 * `voice/output/**`. The engine wires `abortPlayback` to its playback
 * controller's `interrupt()`, which fires the registered stopper -> the TTS
 * controller's own `abort()`.
 */

export type VoiceBargeInSignal = Readonly<{
    sessionId: string;
    source: TurnEndpointSignalSource;
    /** Candidate user transcript captured while the agent was speaking. */
    transcript: string | null | undefined;
    /** How long the agent has been speaking, in ms (drives the protected head). */
    speakingElapsedMs: number;
    /** Spoken duration of the candidate utterance, if measured. */
    durationMs?: number | null;
    /** STT confidence of the candidate utterance, if available. */
    confidence?: number | null;
    /** Defaults to enabled; pass false to short-circuit (settings-driven). */
    bargeInEnabled?: boolean;
}>;

export type VoiceBargeInController = Readonly<{
    /** Record that the agent began speaking the given text (feeds the echo guard). */
    onTtsStarted: (ttsText: string | null | undefined) => void;
    /** Record that the agent stopped speaking. */
    onTtsStopped: () => void;
    onUserSpeechCandidate: (input: Readonly<{
        sessionId: string;
        bargeInEnabled?: boolean;
    }>) => Readonly<{
        status: 'candidate';
        playback: VoicePlaybackInterruptionMode;
    }> | Readonly<{ status: 'ignored' }>;
    cancelUserSpeechCandidate: (input: Readonly<{ sessionId: string }>) => void;
    /**
     * Evaluate a user-speech-during-playback signal and, if it is a real
     * barge-in, abort playback + interrupt + rearm. Returns once any rearm has
     * settled so callers can sequence follow-up work.
     */
    handleUserSpeechDuringPlayback: (signal: VoiceBargeInSignal) => Promise<void>;
}>;

type VoiceBargeInControllerDeps = Readonly<{
    machine: VoiceConversationRuntimeMachine;
    playback: Readonly<{
        beginInterruptionCandidate: () => VoicePlaybackInterruptionMode;
        resolveInterruptionCandidate: (resolution: VoicePlaybackInterruptionResolution) => void;
    }>;
    /** Provider-neutral local side effects (for example heard-text truncation) captured before destructive stop. */
    onConfirmedInterruption?: () => void;
    /** Starts/rearms capture for the rearm leg of the interrupt. */
    startListening: (signal?: AbortSignal) => Promise<void>;
    telemetry?: TurnTakingTelemetry;
    now?: () => number;
    /** Backchannel/echo overrides; defaults applied when absent. */
    adaptiveConfig?: AdaptiveInterruptionConfig;
    echoGuard?: TextualEchoGuard;
    candidateMaxMs?: number;
    setTimer?: (task: () => void, waitMs: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}>;

const BACKCHANNEL_REASON_TO_TELEMETRY: Record<string, TurnTakingTelemetrySuppressionReason> = {
    empty_transcript: 'empty_transcript',
    phrase_match: 'phrase_match',
    min_words: 'min_words',
    low_confidence: 'low_confidence',
    protected_head: 'protected_head',
};

function resolveEchoTelemetryReason(decision: Extract<TextualEchoDecision, { kind: 'drop' }>): 'text_overlap' | 'tts_just_started' {
    return decision.reason === 'text_overlap' ? 'text_overlap' : 'tts_just_started';
}

export function createVoiceBargeInController(deps: VoiceBargeInControllerDeps): VoiceBargeInController {
    const telemetry = deps.telemetry ?? defaultTurnTakingTelemetry;
    const now = deps.now ?? (() => Date.now());
    const echoGuard = deps.echoGuard ?? createTextualEchoGuard({ now });
    const adaptiveConfig: AdaptiveInterruptionConfig = deps.adaptiveConfig ?? {
        ignoredPhrases: DEFAULT_ADAPTIVE_INTERRUPTION_IGNORED_PHRASES,
    };
    const setTimer = deps.setTimer ?? ((task, waitMs) => setTimeout(task, waitMs));
    const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
    const candidateMaxMs = Math.max(1, Math.floor(
        deps.candidateMaxMs ?? VOICE_RUNTIME_CONFIG_DEFAULTS.turnTaking.interruption.candidateMaxMs,
    ));
    let candidate: Readonly<{
        sessionId: string;
        playback: VoicePlaybackInterruptionMode;
        timer: ReturnType<typeof setTimeout>;
    }> | null = null;

    const clearCandidate = (
        resolution: VoicePlaybackInterruptionResolution,
        expectedSessionId?: string,
    ): boolean => {
        const active = candidate;
        if (!active || (expectedSessionId && active.sessionId !== expectedSessionId)) return false;
        candidate = null;
        clearTimer(active.timer);
        deps.playback.resolveInterruptionCandidate(resolution);
        return true;
    };

    const beginCandidate = (input: Readonly<{ sessionId: string; bargeInEnabled?: boolean }>) => {
        if (input.bargeInEnabled === false) return { status: 'ignored' as const };
        const sessionId = String(input.sessionId ?? '').trim();
        const snapshot = deps.machine.getSnapshot();
        if (!sessionId || snapshot.state !== 'speaking' || snapshot.controlSessionId !== sessionId) {
            return { status: 'ignored' as const };
        }
        if (candidate?.sessionId === sessionId) {
            return { status: 'candidate' as const, playback: candidate.playback };
        }
        clearCandidate('false_alarm');
        const playback = deps.playback.beginInterruptionCandidate();
        const timer = setTimer(() => {
            clearCandidate('false_alarm', sessionId);
        }, candidateMaxMs);
        candidate = { sessionId, playback, timer };
        return { status: 'candidate' as const, playback };
    };

    return {
        onTtsStarted: (ttsText) => {
            echoGuard.onTtsStarted(ttsText);
        },
        onTtsStopped: () => {
            clearCandidate('false_alarm');
            echoGuard.onTtsStopped();
        },
        onUserSpeechCandidate: beginCandidate,
        cancelUserSpeechCandidate: ({ sessionId }) => {
            clearCandidate('false_alarm', String(sessionId ?? '').trim());
        },
        handleUserSpeechDuringPlayback: async (signal) => {
            if (signal.bargeInEnabled === false) {
                return;
            }

            const snapshot = deps.machine.getSnapshot();
            // Honor the legal table: a barge-in only applies while the machine is
            // actually speaking for the session that owns it.
            if (snapshot.state !== 'speaking') {
                return;
            }
            const sessionId = String(signal.sessionId ?? '').trim();
            if (!sessionId || snapshot.controlSessionId !== sessionId) {
                return;
            }
            beginCandidate({ sessionId, bargeInEnabled: signal.bargeInEnabled });

            // T3: drop the agent's own TTS echo before anything else.
            const echoDecision = echoGuard.evaluate(signal.transcript);
            if (echoDecision.kind === 'drop') {
                telemetry.recordEchoSuppressed({
                    sessionId,
                    reason: resolveEchoTelemetryReason(echoDecision),
                });
                clearCandidate('false_alarm', sessionId);
                return;
            }

            // T2: protected-head window + backchannel gate. Passing the agent's
            // speaking elapsed makes the first `protectedHeadMs` non-interruptible
            // and demotes exact/brief acknowledgements to backchannels.
            const backchannel = resolveBackchannelDecision({
                config: adaptiveConfig,
                transcript: signal.transcript,
                durationMs: signal.durationMs,
                confidence: signal.confidence,
                speaking: { speakingElapsedMs: signal.speakingElapsedMs },
            });
            if (backchannel.isBackchannel) {
                telemetry.recordBackchannelSuppressed({
                    sessionId,
                    reason: BACKCHANNEL_REASON_TO_TELEMETRY[backchannel.reason] ?? 'min_words',
                });
                clearCandidate('false_alarm', sessionId);
                return;
            }

            // Confirmed barge-in: abort playback, then interrupt + rearm through
            // the machine's own public API (single owner; no duplicated interrupt
            // logic, no guard bypass).
            try {
                deps.onConfirmedInterruption?.();
            } catch {
                // Transcript/telemetry side effects cannot prevent destructive media cancellation.
            }
            clearCandidate('confirmed', sessionId);
            telemetry.recordBargeIn({ sessionId, source: signal.source });
            echoGuard.onTtsStopped();
            await deps.machine.interruptAndRearmListening({
                controlSessionId: sessionId,
                startListening: deps.startListening,
            });
        },
    };
}
