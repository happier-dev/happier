import { describe, expect, it } from 'vitest';

import { createTestTranscriptMeasurementReconciler } from './transcriptMeasurementReconciler';
import type { TranscriptItemHeightValiditySignature } from './transcriptItemHeightCache';
import { resolveTranscriptRowShellHeight } from './resolveTranscriptRowShellHeight';

function stableSignature(
    overrides: Partial<TranscriptItemHeightValiditySignature> = {},
): TranscriptItemHeightValiditySignature {
    return {
        itemId: 'message-1',
        kind: 'message:agent',
        structuralKey: 'message-1:content-v1',
        widthBucket: 'width:400',
        fontScaleKey: 'font:100',
        groupingMode: 'turns',
        forkContextKey: 'fork:root',
        expansionKey: 'tools:collapsed',
        rowState: 'stable',
        ...overrides,
    };
}

describe('resolveTranscriptRowShellHeight', () => {
    it('returns an exact reservation for a measured stable row', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();
        const signature = stableSignature();
        reconciler.recordMeasuredHeight({ signature, heightPx: 184 });

        expect(resolveTranscriptRowShellHeight({ reconciler, signature })).toEqual({ kind: 'exact', minHeight: 184 });
    });

    it('does not expose dead FlashList estimate props', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();
        const signature = stableSignature();
        reconciler.recordMeasuredHeight({ signature, heightPx: 184 });

        const reservation = resolveTranscriptRowShellHeight({ reconciler, signature });

        expect(reservation).not.toHaveProperty('estimatedItemSize');
        expect(reservation).not.toHaveProperty('overrideItemLayout');
    });

    it('returns undefined for a never-measured row but a monotonic floor once a streaming row was measured', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();

        expect(resolveTranscriptRowShellHeight({
            reconciler,
            signature: stableSignature({ structuralKey: 'message-1:content-v2' }),
        })).toBeUndefined();

        const streaming = stableSignature({ rowState: 'streaming' });
        expect(resolveTranscriptRowShellHeight({ reconciler, signature: streaming })).toBeUndefined();

        reconciler.recordMeasuredHeight({ signature: streaming, heightPx: 220 });
        expect(resolveTranscriptRowShellHeight({ reconciler, signature: streaming })).toEqual({ kind: 'floor', minHeight: 220 });
    });

    it('suppresses an inherited floor during a shrink-capable structural transition render', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();
        const runningHeader = stableSignature({
            itemId: 'group-1#header',
            kind: 'tool-group',
            structuralKey: 'group-1|status:running',
        });
        const completedHeader = stableSignature({
            itemId: 'group-1#header',
            kind: 'tool-group',
            structuralKey: 'group-1|status:completed',
        });

        reconciler.recordMeasuredHeight({ signature: runningHeader, heightPx: 36 });

        expect(resolveTranscriptRowShellHeight({
            previousSignature: runningHeader,
            reconciler,
            signature: completedHeader,
        })).toBeUndefined();
    });
});
