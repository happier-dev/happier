import { computeTurnEndpointDelayMs, type TurnEndpointPolicy } from '@/voice/runtime/input/TurnEndpointDetector';

/**
 * Optional semantic end-of-utterance (EOU) enhancement seam (L3.T5).
 *
 * Today endpointing truth is purely acoustic: "Silero said silence for the
 * hangover window" (see `TurnEndpointDetector`/`TurnEndpointController`). The
 * research audit's P0 recommendation is to add a SECOND gate after the silence
 * timer fires — a model that reads the partial transcript (and, later, the raw
 * audio window) and confirms whether the user's turn is actually complete:
 * "VAD = trigger, model = confirm" (LiveKit/Pipecat smart-turn pattern).
 *
 * This module ships ONLY the seam, not a model:
 *  - `SemanticEndpointDetector` is the pluggable contract a future on-device
 *    EOU model (e.g. Pipecat smart-turn-v3 via onnxruntime, or the machine-
 *    scoped DaemonVoiceInference controller) implements.
 *  - `createNoopSemanticEndpointDetector()` is the default: it always returns
 *    `undecided`, so the policy falls back to today's pure-silence delay. This
 *    keeps behavior identical until a real detector is wired in, mirroring the
 *    existing bridge-absent graceful fallback.
 *  - `resolveSemanticEndpointDelayMs(...)` is the single composition point the
 *    endpoint policy calls: it blends the detector verdict with the silence
 *    policy into a final wait, bounded by a hard-max ceiling.
 *
 * EXTENSION POINT: to plug in a real model, implement `SemanticEndpointDetector`
 * and inject it where `createNoopSemanticEndpointDetector()` is used. Do NOT add
 * a heavy model here — keep this layer pure and synchronous; an async model
 * should resolve its verdict before calling `resolveSemanticEndpointDelayMs`.
 */

export type SemanticEndpointInput = Readonly<{
    /** Latest partial/committed transcript for the in-flight turn (may be empty). */
    transcript: string | null | undefined;
    /** Speech elapsed so far for the current utterance, in ms. */
    speechElapsedMs: number;
    /** Optional STT confidence for the latest transcript, if available. */
    confidence?: number | null;
}>;

export type SemanticEndpointVerdict =
    | Readonly<{ kind: 'complete'; confidence: number }>
    | Readonly<{ kind: 'incomplete'; confidence: number }>
    | Readonly<{ kind: 'undecided' }>;

export type SemanticEndpointDetector = Readonly<{
    evaluate: (input: SemanticEndpointInput) => SemanticEndpointVerdict;
}>;

/**
 * Default detector: always defers to the acoustic silence policy. Use this until
 * a real on-device EOU model is wired into the seam.
 */
export function createNoopSemanticEndpointDetector(): SemanticEndpointDetector {
    return {
        evaluate: () => ({ kind: 'undecided' }),
    };
}

/** Default hard-max ceiling for the endpoint wait (research P0: ~3 s catch-all). */
export const DEFAULT_SEMANTIC_ENDPOINT_MAX_DELAY_MS = 3_000;

function clampDelay(value: number, maxDelayMs: number): number {
    if (!Number.isFinite(value) || value <= 0) {
        return 0;
    }
    return Math.min(value, maxDelayMs);
}

/**
 * Blend the semantic verdict with the silence-policy delay into a final
 * endpoint wait, bounded by `maxDelayMs`.
 *
 *  - `complete`   → fire fast: collapse to the confident floor (0 ms).
 *  - `incomplete` → be patient: extend toward the hard-max ceiling.
 *  - `undecided`  → fall back to the supplied `baseDelayMs` (pure-silence path).
 *
 * `baseDelayMs` is the acoustic delay from `computeTurnEndpointDelayMs`; pass it
 * explicitly so this composition has no hidden dependency on the policy state.
 */
export function resolveSemanticEndpointDelayMs(args: Readonly<{
    detector: SemanticEndpointDetector;
    policy: TurnEndpointPolicy;
    baseDelayMs: number;
    transcript: string | null | undefined;
    speechElapsedMs: number;
    confidence?: number | null;
    maxDelayMs?: number;
}>): number {
    const maxDelayMs = typeof args.maxDelayMs === 'number' && Number.isFinite(args.maxDelayMs) && args.maxDelayMs >= 0
        ? args.maxDelayMs
        : DEFAULT_SEMANTIC_ENDPOINT_MAX_DELAY_MS;

    const verdict = args.detector.evaluate({
        transcript: args.transcript,
        speechElapsedMs: args.speechElapsedMs,
        confidence: args.confidence,
    });

    if (verdict.kind === 'complete') {
        return 0;
    }

    if (verdict.kind === 'incomplete') {
        // Patient: never fire before the policy's own minimum, and push the wait
        // out toward the ceiling so a clearly-unfinished thought is not clipped.
        const policyFloor = computeTurnEndpointDelayMs(args.policy, args.speechElapsedMs);
        return clampDelay(Math.max(args.baseDelayMs, policyFloor) + args.policy.silenceMs, maxDelayMs);
    }

    return clampDelay(args.baseDelayMs, maxDelayMs);
}
