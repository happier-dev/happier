import { describe, expect, it } from 'vitest';

import {
    DEFAULT_ADAPTIVE_INTERRUPTION_IGNORED_PHRASES,
    resolveAdaptiveBargeInDecision,
    resolveAdaptiveEndpointDecision,
} from './resolveAdaptiveInterruptionDecision';

describe('resolveAdaptiveInterruptionDecision', () => {
    it('ignores configured backchannel transcripts and keeps the hands-free loop armed', () => {
        expect(resolveAdaptiveEndpointDecision({
            config: {
                ignoredPhrases: DEFAULT_ADAPTIVE_INTERRUPTION_IGNORED_PHRASES,
            },
            continueHandsFree: true,
            transcript: ' yeah ',
        })).toEqual({
            kind: 'ignore',
            reason: 'backchannel',
            shouldRearm: true,
        });
    });

    it('submits substantive endpoint transcripts as turns', () => {
        expect(resolveAdaptiveEndpointDecision({
            config: {
                ignoredPhrases: DEFAULT_ADAPTIVE_INTERRUPTION_IGNORED_PHRASES,
            },
            continueHandsFree: true,
            transcript: 'open the most recent notes',
        })).toEqual({
            kind: 'submit_turn',
            transcript: 'open the most recent notes',
        });
    });

    it('keeps manual barge-in policy explicit', () => {
        expect(resolveAdaptiveBargeInDecision({ bargeInEnabled: false })).toEqual({
            kind: 'noop',
            reason: 'barge_in_disabled',
        });
        expect(resolveAdaptiveBargeInDecision({ bargeInEnabled: true })).toEqual({
            kind: 'interrupt_and_rearm',
            reason: 'manual_barge_in',
        });
    });
});
