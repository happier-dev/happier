import { normalizeInterruptionTranscript } from '@/voice/runtime/input/normalizeInterruptionTranscript';
import { VOICE_RUNTIME_CONFIG_DEFAULTS } from '@/voice/runtime/voiceRuntimeConfigDefaults';

/**
 * Textual (semantic) echo cancellation for open-speaker barge-in.
 *
 * Happier knows the exact text it is speaking, so a near-free guard can drop a
 * candidate user turn that is really the agent hearing itself: if the candidate
 * text overlaps the currently-playing TTS text above a threshold (~0.7), or it
 * arrives inside a short "TTS just started" window before platform AEC has
 * converged (~150-250 ms), treat it as echo and drop it.
 *
 * Pure functions + a small stateful tracker. Wiring into the capture/barge-in
 * machine is a later lane — this module only exposes the guard + interface.
 */

export type TextualEchoGuardConfig = Readonly<{
    /** Drop when candidate↔TTS token overlap is at least this ratio. */
    overlapThreshold: number;
    /** Drop any candidate arriving within this window after TTS start (AEC not converged). */
    justStartedGuardMs: number;
}>;

/**
 * Sourced from the canonical voice runtime config owner so the threshold lives
 * in one place (no magic numbers at call sites).
 */
export const DEFAULT_TEXTUAL_ECHO_GUARD: TextualEchoGuardConfig = Object.freeze({
    overlapThreshold: VOICE_RUNTIME_CONFIG_DEFAULTS.turnTaking.textualEchoGuard.overlapThreshold,
    justStartedGuardMs: VOICE_RUNTIME_CONFIG_DEFAULTS.turnTaking.textualEchoGuard.justStartedGuardMs,
});

function tokenize(value: string | null | undefined): string[] {
    const normalized = normalizeInterruptionTranscript(value);
    return normalized ? normalized.split(' ') : [];
}

/**
 * Fraction of the candidate's tokens that also appear in the TTS text
 * (token-set containment). 1 = every candidate word is in the TTS output.
 */
export function textOverlapRatio(candidate: string | null | undefined, ttsText: string | null | undefined): number {
    const candidateTokens = tokenize(candidate);
    const ttsTokens = tokenize(ttsText);
    if (candidateTokens.length === 0 || ttsTokens.length === 0) {
        return 0;
    }
    const ttsSet = new Set(ttsTokens);
    const matched = candidateTokens.reduce((count, token) => (ttsSet.has(token) ? count + 1 : count), 0);
    return matched / candidateTokens.length;
}

export type TextualEchoDecision =
    | Readonly<{ kind: 'keep' }>
    | Readonly<{ kind: 'drop'; reason: 'text_overlap'; overlap: number }>
    | Readonly<{ kind: 'drop'; reason: 'tts_just_started' }>;

function resolveConfig(config?: Partial<TextualEchoGuardConfig>): TextualEchoGuardConfig {
    if (!config) {
        return DEFAULT_TEXTUAL_ECHO_GUARD;
    }
    return {
        overlapThreshold: typeof config.overlapThreshold === 'number'
            ? config.overlapThreshold
            : DEFAULT_TEXTUAL_ECHO_GUARD.overlapThreshold,
        justStartedGuardMs: typeof config.justStartedGuardMs === 'number'
            ? config.justStartedGuardMs
            : DEFAULT_TEXTUAL_ECHO_GUARD.justStartedGuardMs,
    };
}

/**
 * Decide whether a candidate user turn should be dropped as TTS echo.
 *
 * `ttsText` null/empty means nothing is playing → always keep. An empty
 * candidate is kept (nothing to guard). When `msSinceTtsStarted` is within the
 * just-started window the candidate is dropped regardless of overlap.
 */
export function resolveTextualEchoDecision(args: Readonly<{
    candidateTranscript: string | null | undefined;
    ttsText: string | null | undefined;
    msSinceTtsStarted?: number | null;
    config?: Partial<TextualEchoGuardConfig>;
}>): TextualEchoDecision {
    const config = resolveConfig(args.config);
    const candidate = normalizeInterruptionTranscript(args.candidateTranscript);
    const tts = normalizeInterruptionTranscript(args.ttsText);
    if (!candidate || !tts) {
        return { kind: 'keep' };
    }

    if (
        typeof args.msSinceTtsStarted === 'number'
        && Number.isFinite(args.msSinceTtsStarted)
        && args.msSinceTtsStarted >= 0
        && args.msSinceTtsStarted < config.justStartedGuardMs
    ) {
        return { kind: 'drop', reason: 'tts_just_started' };
    }

    const overlap = textOverlapRatio(candidate, tts);
    if (overlap >= config.overlapThreshold) {
        return { kind: 'drop', reason: 'text_overlap', overlap };
    }

    return { kind: 'keep' };
}

export type TextualEchoGuard = Readonly<{
    /** Record that the agent began speaking the given text. */
    onTtsStarted: (ttsText: string | null | undefined) => void;
    /** Record that the agent stopped speaking. */
    onTtsStopped: () => void;
    /** True if the candidate should be dropped as echo against the current TTS state. */
    shouldDrop: (candidateTranscript: string | null | undefined) => boolean;
    /** The full decision (with reason/overlap) for the candidate. */
    evaluate: (candidateTranscript: string | null | undefined) => TextualEchoDecision;
}>;

export function createTextualEchoGuard(deps: Readonly<{
    now?: () => number;
    config?: Partial<TextualEchoGuardConfig>;
}> = {}): TextualEchoGuard {
    const now = deps.now ?? (() => Date.now());
    let ttsText: string | null = null;
    let ttsStartedAt: number | null = null;

    const evaluate = (candidateTranscript: string | null | undefined): TextualEchoDecision => {
        if (!ttsText) {
            return { kind: 'keep' };
        }
        return resolveTextualEchoDecision({
            candidateTranscript,
            ttsText,
            msSinceTtsStarted: ttsStartedAt === null ? null : now() - ttsStartedAt,
            config: deps.config,
        });
    };

    return {
        onTtsStarted: (text) => {
            ttsText = normalizeInterruptionTranscript(text) || null;
            ttsStartedAt = ttsText ? now() : null;
        },
        onTtsStopped: () => {
            ttsText = null;
            ttsStartedAt = null;
        },
        shouldDrop: (candidateTranscript) => evaluate(candidateTranscript).kind === 'drop',
        evaluate,
    };
}
