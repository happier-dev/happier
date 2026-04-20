import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

export type AdaptiveInterruptionConfig = Readonly<{
    ignoredPhrases: readonly string[];
}>;

export type AdaptiveEndpointDecision =
    | Readonly<{
        kind: 'ignore';
        reason: 'backchannel' | 'empty_transcript';
        shouldRearm: boolean;
    }>
    | Readonly<{
        kind: 'submit_turn';
        transcript: string;
    }>;

export type AdaptiveBargeInDecision =
    | Readonly<{
        kind: 'interrupt_and_rearm';
        reason: 'manual_barge_in';
    }>
    | Readonly<{
        kind: 'noop';
        reason: 'barge_in_disabled';
    }>;

export const DEFAULT_ADAPTIVE_INTERRUPTION_IGNORED_PHRASES = Object.freeze([
    'yeah',
    'ok',
    'okay',
    'uh huh',
    'uhuh',
    'mm hmm',
    'mmhmm',
]);

function normalizeInterruptionTranscript(value: string | null | undefined): string {
    const normalized = normalizeNonEmptyString(value) ?? '';
    if (!normalized) {
        return '';
    }

    return normalized
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

export function resolveAdaptiveEndpointDecision(args: Readonly<{
    config: AdaptiveInterruptionConfig;
    continueHandsFree: boolean;
    transcript?: string | null;
}>): AdaptiveEndpointDecision {
    const transcript = normalizeNonEmptyString(args.transcript) ?? '';
    if (!transcript) {
        return {
            kind: 'ignore',
            reason: 'empty_transcript',
            shouldRearm: args.continueHandsFree,
        };
    }

    const normalizedTranscript = normalizeInterruptionTranscript(transcript);
    const ignoredPhrases = new Set(
        args.config.ignoredPhrases
            .map((phrase) => normalizeInterruptionTranscript(phrase))
            .filter((phrase) => phrase.length > 0),
    );
    if (ignoredPhrases.has(normalizedTranscript)) {
        return {
            kind: 'ignore',
            reason: 'backchannel',
            shouldRearm: args.continueHandsFree,
        };
    }

    return {
        kind: 'submit_turn',
        transcript,
    };
}

export function resolveAdaptiveBargeInDecision(args: Readonly<{
    bargeInEnabled: boolean;
}>): AdaptiveBargeInDecision {
    if (!args.bargeInEnabled) {
        return {
            kind: 'noop',
            reason: 'barge_in_disabled',
        };
    }

    return {
        kind: 'interrupt_and_rearm',
        reason: 'manual_barge_in',
    };
}
