import { describe, expect, it } from 'vitest';

import {
    createTextualEchoGuard,
    DEFAULT_TEXTUAL_ECHO_GUARD,
    resolveTextualEchoDecision,
    textOverlapRatio,
} from './textualEchoGuard';

describe('textOverlapRatio', () => {
    it('returns 0 when either side is empty', () => {
        expect(textOverlapRatio('', 'hello world')).toBe(0);
        expect(textOverlapRatio('hello world', '')).toBe(0);
    });

    it('measures token-set containment of the candidate within the TTS text', () => {
        // All candidate tokens appear in the TTS text → full overlap.
        expect(textOverlapRatio('the most recent notes', 'opening the most recent notes for you')).toBe(1);
        // Half the candidate tokens appear.
        expect(textOverlapRatio('recent unrelated', 'opening the most recent notes')).toBeCloseTo(0.5, 5);
        // Punctuation/case are normalized away.
        expect(textOverlapRatio('Recent, Notes!', 'the recent notes')).toBe(1);
    });
});

describe('resolveTextualEchoDecision', () => {
    it('drops a candidate whose text overlaps the playing TTS above the threshold', () => {
        expect(resolveTextualEchoDecision({
            candidateTranscript: 'the most recent notes',
            ttsText: 'opening the most recent notes for you',
        })).toEqual({ kind: 'drop', reason: 'text_overlap', overlap: 1 });
    });

    it('keeps a candidate that does not overlap the TTS text', () => {
        expect(resolveTextualEchoDecision({
            candidateTranscript: 'stop and open settings instead',
            ttsText: 'here are your most recent notes',
        })).toEqual({ kind: 'keep' });
    });

    it('drops within the TTS-just-started guard window regardless of overlap', () => {
        expect(resolveTextualEchoDecision({
            candidateTranscript: 'completely different words here',
            ttsText: 'here are your most recent notes',
            msSinceTtsStarted: 100,
        })).toEqual({ kind: 'drop', reason: 'tts_just_started' });

        // Past the guard window with no overlap → keep.
        expect(resolveTextualEchoDecision({
            candidateTranscript: 'completely different words here',
            ttsText: 'here are your most recent notes',
            msSinceTtsStarted: 500,
        })).toEqual({ kind: 'keep' });
    });

    it('keeps the candidate when no TTS is playing', () => {
        expect(resolveTextualEchoDecision({
            candidateTranscript: 'the most recent notes',
            ttsText: null,
        })).toEqual({ kind: 'keep' });
        expect(resolveTextualEchoDecision({
            candidateTranscript: 'the most recent notes',
            ttsText: '   ',
        })).toEqual({ kind: 'keep' });
    });

    it('keeps empty candidates (nothing to guard)', () => {
        expect(resolveTextualEchoDecision({
            candidateTranscript: '   ',
            ttsText: 'most recent notes',
        })).toEqual({ kind: 'keep' });
    });

    it('honours custom thresholds', () => {
        // Raise the overlap threshold so a half-overlap is kept.
        expect(resolveTextualEchoDecision({
            candidateTranscript: 'recent unrelated',
            ttsText: 'the most recent notes',
            config: { ...DEFAULT_TEXTUAL_ECHO_GUARD, overlapThreshold: 0.9 },
        })).toEqual({ kind: 'keep' });
    });

    it('exposes documented defaults', () => {
        expect(DEFAULT_TEXTUAL_ECHO_GUARD).toEqual({ overlapThreshold: 0.7, justStartedGuardMs: 200 });
    });
});

describe('createTextualEchoGuard', () => {
    it('tracks the currently-playing TTS text + start time and guards candidates against it', () => {
        let nowMs = 1_000;
        const guard = createTextualEchoGuard({ now: () => nowMs });

        // No TTS playing yet → keep.
        expect(guard.shouldDrop('the most recent notes')).toBe(false);

        guard.onTtsStarted('opening the most recent notes for you');
        // Inside the just-started window → drop unrelated speech too.
        expect(guard.shouldDrop('completely different here')).toBe(true);

        nowMs = 1_500; // past guard window
        expect(guard.shouldDrop('the most recent notes')).toBe(true); // overlap
        expect(guard.shouldDrop('stop open settings instead now')).toBe(false); // no overlap

        guard.onTtsStopped();
        expect(guard.shouldDrop('the most recent notes')).toBe(false);
    });
});
