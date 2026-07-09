import { describe, expect, it } from 'vitest';

import {
    DEFAULT_ADAPTIVE_INTERRUPTION_IGNORED_PHRASES,
    DEFAULT_BACKCHANNEL_GATE,
    resolveBackchannelDecision,
} from './resolveBackchannelDecision';

describe('resolveBackchannelDecision', () => {
    it('treats empty transcripts as backchannel (nothing to submit)', () => {
        expect(resolveBackchannelDecision({
            config: { ignoredPhrases: DEFAULT_ADAPTIVE_INTERRUPTION_IGNORED_PHRASES },
            transcript: '   ',
        })).toEqual({ isBackchannel: true, reason: 'empty_transcript' });
    });

    it('matches the phrase list as an additional fast-path regardless of word count', () => {
        expect(resolveBackchannelDecision({
            config: { ignoredPhrases: DEFAULT_ADAPTIVE_INTERRUPTION_IGNORED_PHRASES },
            transcript: ' Yeah! ',
        })).toEqual({ isBackchannel: true, reason: 'phrase_match' });
    });

    it('does not demote short finalized turns when duration was not measured', () => {
        expect(resolveBackchannelDecision({
            config: { ignoredPhrases: DEFAULT_ADAPTIVE_INTERRUPTION_IGNORED_PHRASES },
            transcript: 'hands free message',
            durationMs: null,
        })).toEqual({ isBackchannel: false });
    });

    it('filters short low-word utterances that are not exact phrase-list members', () => {
        // "yeah exactly" is 2 words, <= maxWords, and measured short → backchannel by word count.
        expect(resolveBackchannelDecision({
            config: { ignoredPhrases: DEFAULT_ADAPTIVE_INTERRUPTION_IGNORED_PHRASES },
            transcript: 'yeah exactly',
            durationMs: 400,
        })).toEqual({ isBackchannel: true, reason: 'min_words' });
    });

    it('does not filter substantive multi-word turns', () => {
        expect(resolveBackchannelDecision({
            config: { ignoredPhrases: DEFAULT_ADAPTIVE_INTERRUPTION_IGNORED_PHRASES },
            transcript: 'open the most recent notes for me',
        })).toEqual({ isBackchannel: false });
    });

    it('filters a short-word turn that exceeds the duration ceiling only when within word gate', () => {
        // 2 words but spoken over a long duration → not a backchannel (deliberate slow speech).
        expect(resolveBackchannelDecision({
            config: { ignoredPhrases: DEFAULT_ADAPTIVE_INTERRUPTION_IGNORED_PHRASES },
            transcript: 'stop please',
            durationMs: 2_000,
        })).toEqual({ isBackchannel: false });

        // Same words, short duration → backchannel.
        expect(resolveBackchannelDecision({
            config: { ignoredPhrases: DEFAULT_ADAPTIVE_INTERRUPTION_IGNORED_PHRASES },
            transcript: 'stop please',
            durationMs: 400,
        })).toEqual({ isBackchannel: true, reason: 'min_words' });
    });

    it('protects a non-interruptible head while the agent is speaking', () => {
        // A substantive turn arriving inside the protected head is held back as a backchannel.
        expect(resolveBackchannelDecision({
            config: { ignoredPhrases: DEFAULT_ADAPTIVE_INTERRUPTION_IGNORED_PHRASES },
            transcript: 'open the most recent notes for me',
            speaking: { speakingElapsedMs: 200 },
        })).toEqual({ isBackchannel: true, reason: 'protected_head' });

        // Past the protected head the same turn interrupts.
        expect(resolveBackchannelDecision({
            config: { ignoredPhrases: DEFAULT_ADAPTIVE_INTERRUPTION_IGNORED_PHRASES },
            transcript: 'open the most recent notes for me',
            speaking: { speakingElapsedMs: 1_500 },
        })).toEqual({ isBackchannel: false });
    });

    it('applies an optional confidence floor for short utterances', () => {
        // Low-confidence single token → noise/backchannel.
        expect(resolveBackchannelDecision({
            config: {
                ignoredPhrases: DEFAULT_ADAPTIVE_INTERRUPTION_IGNORED_PHRASES,
                gate: { ...DEFAULT_BACKCHANNEL_GATE, minConfidence: 0.6 },
            },
            transcript: 'okayish',
            confidence: 0.2,
        })).toEqual({ isBackchannel: true, reason: 'low_confidence' });
    });

    it('exposes documented default gate thresholds', () => {
        expect(DEFAULT_BACKCHANNEL_GATE).toEqual({
            maxWords: 3,
            maxDurationMs: 700,
            protectedHeadMs: 800,
            minConfidence: null,
        });
    });
});
