import { describe, expect, it } from 'vitest';

import type { TranscriptRowLayoutMutation } from './TranscriptRowLayoutMutationContext';
import type { TranscriptItemHeightValiditySignature } from './transcriptItemHeightCache';
import { createTranscriptMeasurementHost } from './transcriptMeasurementHost';

function signature(
    overrides: Partial<TranscriptItemHeightValiditySignature> = {},
): TranscriptItemHeightValiditySignature {
    return {
        itemId: 'message-1',
        kind: 'message:agent',
        structuralKey: 'message-1:v1',
        widthBucket: 'width:400',
        fontScaleKey: 'font:1',
        groupingMode: 'turn',
        forkContextKey: 'root',
        expansionKey: 'tools:none|thinking:none',
        rowState: 'stable',
        ...overrides,
    };
}

function signatureChange(
    previous: TranscriptItemHeightValiditySignature,
    next: TranscriptItemHeightValiditySignature,
): TranscriptRowLayoutMutation {
    return {
        reason: 'signature-change',
        sourceId: next.itemId,
        previousSignature: previous,
        nextSignature: next,
    };
}

describe('transcriptMeasurementHost', () => {
    it('coalesces structural row cache clears to one effect per commit token', () => {
        const host = createTranscriptMeasurementHost();
        const mutation = signatureChange(
            signature({ expansionKey: 'tools:collapsed|thinking:none' }),
            signature({ expansionKey: 'tools:expanded|thinking:none' }),
        );

        host.advanceLayoutInvalidationCommitToken();

        expect(host.observeRowLayoutMutation({
            mutation,
            viewportTransactionOpen: false,
        }).effects).toEqual([{ type: 'clear-layout-cache', reason: 'structural-delta' }]);
        expect(host.observeRowLayoutMutation({
            mutation,
            viewportTransactionOpen: false,
        }).effects).toEqual([]);

        host.advanceLayoutInvalidationCommitToken();
        expect(host.observeRowLayoutMutation({
            mutation,
            viewportTransactionOpen: false,
        }).effects).toEqual([{ type: 'clear-layout-cache', reason: 'structural-delta' }]);
    });

    it('suppresses global cache clears while a viewport transaction owns the viewport', () => {
        const host = createTranscriptMeasurementHost();
        host.advanceLayoutInvalidationCommitToken();

        expect(host.observeRowLayoutMutation({
            mutation: { reason: 'expand', sourceId: 'message-1' },
            viewportTransactionOpen: true,
        }).effects).toEqual([]);
    });

    it('does not clear the global cache for streaming append churn or stream finalization', () => {
        const host = createTranscriptMeasurementHost();
        host.advanceLayoutInvalidationCommitToken();

        expect(host.observeRowLayoutMutation({
            mutation: signatureChange(
                signature({ rowState: 'streaming', structuralKey: 'token-1' }),
                signature({ rowState: 'streaming', structuralKey: 'token-2' }),
            ),
            viewportTransactionOpen: false,
        }).effects).toEqual([]);

        host.advanceLayoutInvalidationCommitToken();
        expect(host.observeRowLayoutMutation({
            mutation: signatureChange(
                signature({ rowState: 'streaming', structuralKey: 'token-2' }),
                signature({ rowState: 'stable', structuralKey: 'final' }),
            ),
            viewportTransactionOpen: false,
        }).effects).toEqual([]);
    });

    it('resets per-session host state while preserving exact stable-row height cache entries', () => {
        const host = createTranscriptMeasurementHost();
        const stable = signature();

        host.reconciler.recordMeasuredHeight({ signature: stable, heightPx: 168 });
        expect(host.observeContentSizeChange({
            latestCommittedActivityKey: 'activity-1',
            platform: 'native',
            previousMeasuredContentHeight: 0,
            rawContentHeight: 1200,
            sessionActive: false,
            sessionId: 'session-a',
            composerInsetHeight: 44,
        }).status).toBe('measured');
        expect(host.hasNativeContentMeasurementForSession({
            platform: 'native',
            sessionId: 'session-a',
        })).toBe(true);

        host.resetForSession({ sessionId: 'session-b' });

        expect(host.hasNativeContentMeasurementForSession({
            platform: 'native',
            sessionId: 'session-b',
        })).toBe(false);
        expect(host.reconciler.resolveReservation(stable)).toEqual({ kind: 'exact', minHeight: 168 });
    });

    it('normalizes native content size with composer inset and marks native content measured', () => {
        const host = createTranscriptMeasurementHost();
        const observation = host.observeContentSizeChange({
            latestCommittedActivityKey: 'activity-1',
            platform: 'native',
            previousMeasuredContentHeight: 0,
            rawContentHeight: 1200,
            sessionActive: false,
            sessionId: 'session-a',
            composerInsetHeight: 44,
        });

        expect(observation).toEqual({
            status: 'measured',
            contentHeightChanged: true,
            contentHeightGrew: true,
            measuredContentHeight: 1244,
            previousMeasuredContentHeight: 0,
            reason: 'content-size-change',
        });
        expect(host.hasNativeContentMeasurementForSession({
            platform: 'native',
            sessionId: 'session-a',
        })).toBe(true);
    });

    it('classifies active content-size growth and activity-key changes as stream append', () => {
        const host = createTranscriptMeasurementHost();

        expect(host.observeContentSizeChange({
            latestCommittedActivityKey: 'activity-1',
            platform: 'web',
            previousMeasuredContentHeight: 1000,
            rawContentHeight: 1000,
            sessionActive: true,
            sessionId: 'session-a',
            composerInsetHeight: 44,
        })).toMatchObject({
            status: 'measured',
            measuredContentHeight: 1000,
            reason: 'content-size-change',
        });
        expect(host.observeContentSizeChange({
            latestCommittedActivityKey: 'activity-1',
            platform: 'web',
            previousMeasuredContentHeight: 1000,
            rawContentHeight: 1020,
            sessionActive: true,
            sessionId: 'session-a',
            composerInsetHeight: 44,
        })).toMatchObject({
            status: 'measured',
            measuredContentHeight: 1020,
            reason: 'content-size-change',
        });
        expect(host.observeContentSizeChange({
            latestCommittedActivityKey: 'activity-2',
            platform: 'web',
            previousMeasuredContentHeight: 1020,
            rawContentHeight: 1020,
            sessionActive: true,
            sessionId: 'session-a',
            composerInsetHeight: 44,
        })).toMatchObject({
            status: 'measured',
            measuredContentHeight: 1020,
            reason: 'stream-append',
        });
    });

    it('keeps the first positive content materialization as a content-size change after zero-height noise', () => {
        const host = createTranscriptMeasurementHost();

        expect(host.observeContentSizeChange({
            latestCommittedActivityKey: 'activity-1',
            platform: 'native',
            previousMeasuredContentHeight: 0,
            rawContentHeight: 0,
            sessionActive: true,
            sessionId: 'session-a',
            composerInsetHeight: 0,
        })).toMatchObject({
            status: 'measured',
            measuredContentHeight: 0,
            reason: 'content-size-change',
        });
        expect(host.observeContentSizeChange({
            latestCommittedActivityKey: 'activity-1',
            platform: 'native',
            previousMeasuredContentHeight: 0,
            rawContentHeight: 1000,
            sessionActive: true,
            sessionId: 'session-a',
            composerInsetHeight: 0,
        })).toMatchObject({
            status: 'measured',
            measuredContentHeight: 1000,
            reason: 'content-size-change',
        });
    });

    it('ignores non-finite content-size observations without advancing stream classification state', () => {
        const host = createTranscriptMeasurementHost();

        expect(host.observeContentSizeChange({
            latestCommittedActivityKey: 'activity-1',
            platform: 'web',
            previousMeasuredContentHeight: 1000,
            rawContentHeight: Number.NaN,
            sessionActive: true,
            sessionId: 'session-a',
            composerInsetHeight: 0,
        })).toEqual({ status: 'ignored' });
        expect(host.observeContentSizeChange({
            latestCommittedActivityKey: 'activity-1',
            platform: 'web',
            previousMeasuredContentHeight: 1000,
            rawContentHeight: 1020,
            sessionActive: true,
            sessionId: 'session-a',
            composerInsetHeight: 0,
        })).toMatchObject({
            status: 'measured',
            reason: 'content-size-change',
        });
    });
});
