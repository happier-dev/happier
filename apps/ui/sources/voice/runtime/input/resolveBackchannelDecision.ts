import { VOICE_RUNTIME_CONFIG_DEFAULTS } from '@/voice/runtime/voiceRuntimeConfigDefaults';

import {
    countInterruptionWords,
    normalizeInterruptionTranscript,
} from './normalizeInterruptionTranscript';

/**
 * Tunable thresholds for the contextual backchannel / false-barge filter.
 *
 * Replaces the old exact-full-string match: short, low-word, low-confidence
 * utterances (and anything inside the agent's protected speaking head) are
 * treated as backchannels and do not yield the floor. The phrase list remains
 * an additional fast-path for very short acknowledgements.
 */
export type BackchannelGate = Readonly<{
    /** Utterances with at most this many words are candidate backchannels. */
    maxWords: number;
    /** Utterances no longer than this (when duration is known) are candidate backchannels. */
    maxDurationMs: number;
    /** While the agent is speaking, the first window is non-interruptible. */
    protectedHeadMs: number;
    /** Optional STT-confidence floor; below it a short utterance is treated as noise. */
    minConfidence: number | null;
}>;

export type AdaptiveInterruptionConfig = Readonly<{
    ignoredPhrases: readonly string[];
    /** Optional gate overrides; defaults applied when absent. */
    gate?: Partial<BackchannelGate>;
}>;

export const DEFAULT_ADAPTIVE_INTERRUPTION_IGNORED_PHRASES = Object.freeze([
    'yeah',
    'ok',
    'okay',
    'mhm',
    'uh huh',
    'uhuh',
    'mm hmm',
    'mmhmm',
]);

/**
 * Documented, testable default gate thresholds (research-backed). Sourced from
 * the canonical voice runtime config owner so the threshold lives in one place
 * (no magic numbers at call sites).
 */
export const DEFAULT_BACKCHANNEL_GATE: BackchannelGate = Object.freeze({
    maxWords: VOICE_RUNTIME_CONFIG_DEFAULTS.turnTaking.backchannelGate.maxWords,
    maxDurationMs: VOICE_RUNTIME_CONFIG_DEFAULTS.turnTaking.backchannelGate.maxDurationMs,
    protectedHeadMs: VOICE_RUNTIME_CONFIG_DEFAULTS.turnTaking.backchannelGate.protectedHeadMs,
    minConfidence: VOICE_RUNTIME_CONFIG_DEFAULTS.turnTaking.backchannelGate.minConfidence,
});

export type BackchannelDecision =
    | Readonly<{
        isBackchannel: true;
        reason: 'empty_transcript' | 'phrase_match' | 'min_words' | 'low_confidence' | 'protected_head';
    }>
    | Readonly<{
        isBackchannel: false;
    }>;

function resolveGate(config: AdaptiveInterruptionConfig): BackchannelGate {
    const gate = config.gate;
    if (!gate) {
        return DEFAULT_BACKCHANNEL_GATE;
    }
    return {
        maxWords: typeof gate.maxWords === 'number' ? gate.maxWords : DEFAULT_BACKCHANNEL_GATE.maxWords,
        maxDurationMs: typeof gate.maxDurationMs === 'number' ? gate.maxDurationMs : DEFAULT_BACKCHANNEL_GATE.maxDurationMs,
        protectedHeadMs: typeof gate.protectedHeadMs === 'number' ? gate.protectedHeadMs : DEFAULT_BACKCHANNEL_GATE.protectedHeadMs,
        minConfidence: typeof gate.minConfidence === 'number' ? gate.minConfidence : DEFAULT_BACKCHANNEL_GATE.minConfidence,
    };
}

function buildPhraseSet(ignoredPhrases: readonly string[]): ReadonlySet<string> {
    return new Set(
        ignoredPhrases
            .map((phrase) => normalizeInterruptionTranscript(phrase))
            .filter((phrase) => phrase.length > 0),
    );
}

/**
 * Decide whether a candidate user utterance is a non-interruptible backchannel.
 *
 * Order of checks:
 *  1. empty transcript → backchannel (nothing to submit).
 *  2. while the agent is speaking, inside the protected head → backchannel.
 *  3. exact phrase-list membership → backchannel (fast-path).
 *  4. short (≤ maxWords) low-confidence utterances → backchannel/noise when
 *     confidence is known and below the optional floor.
 *  5. short (≤ maxWords) AND measured short-enough (≤ maxDurationMs) → backchannel.
 *     Unknown duration is not enough to demote a finalized STT turn because
 *     finalized fallback sources often cannot measure the spoken span.
 * Otherwise it is a substantive turn that may submit / interrupt.
 */
export function resolveBackchannelDecision(args: Readonly<{
    config: AdaptiveInterruptionConfig;
    transcript?: string | null;
    /** Spoken duration of the candidate utterance, if measured. */
    durationMs?: number | null;
    /** STT confidence of the candidate utterance, if available. */
    confidence?: number | null;
    /** Present when the agent is currently speaking (barge-in path). */
    speaking?: Readonly<{ speakingElapsedMs: number }> | null;
}>): BackchannelDecision {
    const normalized = normalizeInterruptionTranscript(args.transcript);
    if (!normalized) {
        return { isBackchannel: true, reason: 'empty_transcript' };
    }

    const gate = resolveGate(args.config);

    if (args.speaking && args.speaking.speakingElapsedMs >= 0 && args.speaking.speakingElapsedMs < gate.protectedHeadMs) {
        return { isBackchannel: true, reason: 'protected_head' };
    }

    if (buildPhraseSet(args.config.ignoredPhrases).has(normalized)) {
        return { isBackchannel: true, reason: 'phrase_match' };
    }

    const wordCount = countInterruptionWords(normalized);
    const withinWordGate = wordCount <= gate.maxWords;
    const durationKnown = typeof args.durationMs === 'number' && Number.isFinite(args.durationMs);

    if (withinWordGate) {
        if (
            typeof gate.minConfidence === 'number'
            && typeof args.confidence === 'number'
            && Number.isFinite(args.confidence)
            && args.confidence < gate.minConfidence
        ) {
            return { isBackchannel: true, reason: 'low_confidence' };
        }
        if (durationKnown && (args.durationMs as number) <= gate.maxDurationMs) {
            return { isBackchannel: true, reason: 'min_words' };
        }
    }

    return { isBackchannel: false };
}
