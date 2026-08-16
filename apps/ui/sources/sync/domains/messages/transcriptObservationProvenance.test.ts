import { describe, expect, it } from 'vitest';

import { isRecoveredHistoryTranscriptObservation } from './transcriptObservationProvenance';

describe('recovered-history transcript observation provenance', () => {
    it('keeps the UI adapter callable while delegating strict history-only classification', () => {
        expect(isRecoveredHistoryTranscriptObservation({
            transcriptObservationProvenance: { kind: 'non_dependent', source: 'history' },
        })).toBe(true);
        for (const source of ['background', 'external', 'sidechain'] as const) {
            expect(isRecoveredHistoryTranscriptObservation({
                transcriptObservationProvenance: { kind: 'non_dependent', source },
            })).toBe(false);
        }
        expect(isRecoveredHistoryTranscriptObservation(null)).toBe(false);
    });
});
