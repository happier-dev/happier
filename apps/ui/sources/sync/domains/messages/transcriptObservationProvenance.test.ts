import { describe, expect, it } from 'vitest';

import {
    applyTranscriptObservationMetadata,
    isRecoveredHistoryTranscriptObservation,
} from './transcriptObservationProvenance';

describe('applyTranscriptObservationMetadata', () => {
    it('fails closed for an absent or malformed message action reference while retaining a valid replacement', () => {
        const initialReference = {
            v: 1,
            sessionId: 'session-1',
            messageId: 'message-1',
            observedRevision: 'revision-1',
        } as const;
        const target = { messageActionReference: initialReference };

        applyTranscriptObservationMetadata(target, {});
        expect(target.messageActionReference).toBeUndefined();

        target.messageActionReference = initialReference;
        applyTranscriptObservationMetadata(target, {
            messageActionReference: {
                ...initialReference,
                localId: 'optimistic-local-id',
            } as never,
        });
        expect(target.messageActionReference).toBeUndefined();

        const replacementReference = {
            ...initialReference,
            observedRevision: 'revision-2',
        } as const;
        applyTranscriptObservationMetadata(target, {
            messageActionReference: replacementReference,
        });
        expect(target.messageActionReference).toEqual(replacementReference);
    });

    it('keeps the compatibility adapter callable while using strict protocol classification', () => {
        expect(isRecoveredHistoryTranscriptObservation({
            transcriptObservationProvenance: { kind: 'non_dependent', source: 'history' },
        })).toBe(true);
        for (const source of ['background', 'external', 'sidechain'] as const) {
            expect(isRecoveredHistoryTranscriptObservation({
                transcriptObservationProvenance: { kind: 'non_dependent', source },
            })).toBe(false);
        }
        expect(isRecoveredHistoryTranscriptObservation({
            transcriptObservationProvenance: {
                kind: 'non_dependent',
                source: 'history',
                trusted: true,
            } as never,
        })).toBe(false);
    });
});
