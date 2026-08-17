import { describe, expect, it } from 'vitest';

import { estimateTranscriptRowHeightFromCache } from './estimateTranscriptRowHeightFromCache';
import { resolveTranscriptRowShellHeight } from './resolveTranscriptRowShellHeight';
import type { TranscriptItemHeightValiditySignature } from './transcriptItemHeightCache';
import {
    createTestTranscriptMeasurementReconciler,
    isStructuralSignatureDelta,
} from './transcriptMeasurementReconciler';

/**
 * W-1/W17 — the SETTLE boundary: a row that has just stopped growing must be virtualized from its
 * own last real measurement, never from the growth-episode peak and never from the flat content
 * heuristic.
 *
 * Why this boundary exists at all, in THIS repo's bytes (DERIVED from source, all three legs):
 *  1. `buildGrowingMessageShellStructuralKey` (R2, `transcriptRowShellSignature`) gives a GROWING
 *     message the identity-only key `<id>:growing`, so a streaming reply's structural key is
 *     constant across every chunk and its measured size survives the stream.
 *  2. At the finalize, BOTH `rowState` (`streaming` -> `stable`) and `structuralKey`
 *     (`<id>:growing` -> `<id>:r<n>`, since {@link buildMessageShellStructuralKey} is revision-keyed
 *     for a settled row) move in the same commit. `ChatListInternal` wires the vendored Legend
 *     `getItemSizeVersion` to `buildTranscriptItemHeightSignatureKey(...)`, and the patch's
 *     `validateItemSizeVersion` answers a moved version by deleting the row's `sizesKnown` AND
 *     `sizes` entries — so the renderer asks this owner for a size at exactly that instant.
 *  3. The moved `structuralKey` also makes `isFloorShapeValid` refuse the streaming floor (the row is
 *     no longer growing, so the shape leg applies), and the exact-height LRU has no entry for the
 *     settled signature yet. Without a third read the estimate falls through to
 *     `estimateTranscriptRowHeightFromContent` — the flat, width-blind wrap model, measured +6.7%
 *     against a real 21,229-character reply on device (2026-08-10). Accumulated by Legend, that error
 *     is a visible jump under the row the user is watching, once per settle.
 *
 * R2 therefore removes the PER-CHUNK excursion on its own, but only this read removes the PER-SETTLE
 * one: the app already holds the row's real height from the final streamed frame, and a prediction
 * (unlike a reservation) is discarded by that row's very next onLayout, so serving it costs nothing.
 *
 * The peak/last-measurement split is the other half: the floor is a deliberate cross-shape MAXIMUM
 * over frames a growing row no longer paints, so it is a lower bound, not a size. Live web capture
 * 2026-07-28 (sibling repo, session `cmrdwwsd60bg0tmo6n0k6zq79`) measured [42, 24, 48]px of blank
 * band under three settled messages when the peak was served as a size, every one of them at a
 * `msg->toolCalls` boundary; every `toolCalls->*` boundary measured 0, because
 * `resolveMessageRowState` pins tool rows out of the growing states. That is why the prediction is
 * the row's own LAST height and never the floor.
 */
const STREAM_PEAK_PX = 500;
const SETTLED_HEIGHT_PX = 452;

/** What R2's {@link buildGrowingMessageShellStructuralKey} emits while the row is growing. */
const GROWING_STRUCTURAL_KEY = 'msg:isv1earckyq:growing';
/** What `buildMessageShellStructuralKey` emits once the row is settled (revision-keyed). */
const SETTLED_STRUCTURAL_KEY = 'msg:isv1earckyq:r8';

function messageSignature(
    overrides: Partial<TranscriptItemHeightValiditySignature> = {},
): TranscriptItemHeightValiditySignature {
    return {
        itemId: 'msg:isv1earckyq',
        kind: 'message:agent',
        structuralKey: GROWING_STRUCTURAL_KEY,
        widthBucket: 'width:800',
        fontScaleKey: 'font:1',
        groupingMode: 'turn',
        forkContextKey: 'root',
        expansionKey: 'tools:none|thinking:none',
        rowState: 'streaming',
        ...overrides,
    };
}

describe('W-1 · the settle boundary is virtualized from the row\'s own last measurement', () => {
    it('serves the final streamed height, not the growth peak and not the content heuristic', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();

        // The reply streams. Its tallest frame is the peak the monotonic floor exists to hold; the
        // final frame paints shorter (a markdown re-flow closing a list/fence).
        reconciler.recordMeasuredHeight({
            signature: messageSignature(),
            heightPx: STREAM_PEAK_PX,
        });
        reconciler.recordMeasuredHeight({
            signature: messageSignature(),
            heightPx: SETTLED_HEIGHT_PX,
        });

        const settled = messageSignature({
            rowState: 'stable',
            structuralKey: SETTLED_STRUCTURAL_KEY,
        });

        // A reservation is a forcing, self-fulfilling `minHeight`, so nothing may be forced here:
        // the row measures naturally. (Both of these already hold — they are the invariant this
        // change must not spend.)
        expect(reconciler.resolveReservation(settled)).toBeUndefined();
        expect(resolveTranscriptRowShellHeight({ reconciler, signature: settled })).toBeUndefined();

        // The virtualization estimate is the row's own last REAL measurement. `toBe` here is what
        // kills the two plausible wrong implementations at once: `undefined` (fall through to the
        // flat content model) and `STREAM_PEAK_PX` (serve the floor as if it were a size).
        expect(estimateTranscriptRowHeightFromCache({ reconciler, signature: settled }))
            .toBe(SETTLED_HEIGHT_PX);
    });

    it('DISCRIMINATOR: predicts nothing for a row this app run never measured', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();
        reconciler.recordMeasuredHeight({ signature: messageSignature(), heightPx: SETTLED_HEIGHT_PX });

        // A different row entirely, and the same row at a geometry it was never measured at. An
        // implementation that hands back "some measurement" rather than THIS row's own is refused
        // here; a never-measured row must still fall through to the content estimate.
        const otherRow = messageSignature({
            itemId: 'msg:never-measured',
            rowState: 'stable',
            structuralKey: 'msg:never-measured:r1',
        });
        const otherWidth = messageSignature({
            rowState: 'stable',
            structuralKey: SETTLED_STRUCTURAL_KEY,
            widthBucket: 'width:1200',
        });
        const otherFontScale = messageSignature({
            fontScaleKey: 'font:1.35',
            rowState: 'stable',
            structuralKey: SETTLED_STRUCTURAL_KEY,
        });

        expect(estimateTranscriptRowHeightFromCache({ reconciler, signature: otherRow })).toBeUndefined();
        expect(estimateTranscriptRowHeightFromCache({ reconciler, signature: otherWidth })).toBeUndefined();
        expect(estimateTranscriptRowHeightFromCache({ reconciler, signature: otherFontScale })).toBeUndefined();
    });

    it('DISCRIMINATOR: predicts nothing while a MOUNTED row is reset-pending', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();
        reconciler.recordMeasuredHeight({ signature: messageSignature(), heightPx: STREAM_PEAK_PX });

        const settled = messageSignature({
            rowState: 'stable',
            structuralKey: SETTLED_STRUCTURAL_KEY,
        });
        // `ChatListRows`' layout effect on the settle delta: the row is mounted and re-measures this
        // frame, so there is no stale measurement worth predicting from.
        expect(isStructuralSignatureDelta(messageSignature(), settled)).toBe(true);
        reconciler.resetReservationForStructuralChange({ itemId: settled.itemId, signature: settled });

        expect(estimateTranscriptRowHeightFromCache({ reconciler, signature: settled })).toBeUndefined();
    });

    it('NEGATIVE: a row that is STILL growing keeps falling through to the content estimate', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();
        reconciler.recordMeasuredHeight({ signature: messageSignature(), heightPx: SETTLED_HEIGHT_PX });

        // A growing row's last frame is stale by construction — its content is still arriving — and
        // the content estimate tracks the live text. An implementation that reads the prediction
        // before the growing gate would freeze the row at the height it had one chunk ago.
        expect(estimateTranscriptRowHeightFromCache({ reconciler, signature: messageSignature() }))
            .toBeUndefined();
        expect(estimateTranscriptRowHeightFromCache({
            reconciler,
            signature: messageSignature({ kind: 'message:thinking', rowState: 'thinking' }),
        })).toBeUndefined();
    });

    it('NEGATIVE: the settled row\'s own layout takes over as an EXACT reservation', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();
        reconciler.recordMeasuredHeight({ signature: messageSignature(), heightPx: STREAM_PEAK_PX });

        const settled = messageSignature({
            rowState: 'stable',
            structuralKey: SETTLED_STRUCTURAL_KEY,
        });
        reconciler.resetReservationForStructuralChange({ itemId: settled.itemId, signature: settled });
        reconciler.recordMeasuredHeight({ signature: settled, heightPx: SETTLED_HEIGHT_PX });

        expect(reconciler.resolveReservation(settled)).toEqual({ kind: 'exact', minHeight: SETTLED_HEIGHT_PX });
        expect(estimateTranscriptRowHeightFromCache({ reconciler, signature: settled })).toBe(SETTLED_HEIGHT_PX);
    });

    it('NEGATIVE: the monotonic floor still holds while the row grows (no mid-stream shrink jitter)', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();
        reconciler.recordMeasuredHeight({ signature: messageSignature(), heightPx: STREAM_PEAK_PX });
        reconciler.recordMeasuredHeight({ signature: messageSignature(), heightPx: SETTLED_HEIGHT_PX });

        // The prediction follows the row down; the RESERVATION must not, or a transient short frame
        // becomes an append overlap.
        expect(reconciler.resolveReservation(messageSignature()))
            .toEqual({ kind: 'floor', minHeight: STREAM_PEAK_PX });
    });
});

/**
 * W17 — the floor's provenance leg. A floor recorded under one PRESENTATION is not a bound on
 * another, even when both are growing.
 *
 * `resolveMessageRowState` returns 'thinking' BEFORE any streaming branch, so a live thinking block
 * renders as `message:thinking`/`thinking`. When `activeThinkingMessageId` moves on, the SAME row
 * (same `itemId`, same geometry, and — after R2 — the same identity-only `:growing` structural key)
 * re-renders as `message:agent`. With `structuralKey` as the only gate, the thinking block's peak
 * compares valid against the agent row and is served as a FORCING `minHeight` on a row that paints a
 * fraction of it.
 */
describe('W17 · a growing floor is scoped to the presentation it was measured in', () => {
    function thinkingRow(
        overrides: Partial<TranscriptItemHeightValiditySignature> = {},
    ): TranscriptItemHeightValiditySignature {
        return messageSignature({
            itemId: 'msg:thinking-1',
            kind: 'message:thinking',
            rowState: 'thinking',
            structuralKey: 'msg:thinking-1:growing',
            ...overrides,
        });
    }

    it('does not carry a thinking peak into the agent presentation, growing or settled', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();
        reconciler.recordMeasuredHeight({ signature: thinkingRow(), heightPx: 612 });
        // The block collapses to its summary while still growing.
        reconciler.recordMeasuredHeight({ signature: thinkingRow(), heightPx: 96 });

        const stillGrowing = thinkingRow({ kind: 'message:agent', rowState: 'streaming' });
        const settled = thinkingRow({
            kind: 'message:agent',
            rowState: 'stable',
            structuralKey: 'msg:thinking-1:r8',
        });

        expect(reconciler.resolveReservation(stillGrowing)).toBeUndefined();
        expect(reconciler.resolveReservation(settled)).toBeUndefined();
        // The prediction is deliberately NOT provenance-gated: it is replaced by the row's own next
        // onLayout, so the row's last real height beats the flat content model even across a
        // presentation change.
        expect(estimateTranscriptRowHeightFromCache({ reconciler, signature: settled })).toBe(96);
    });

    it('NEGATIVE: the same presentation still carries its peak across content churn', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();
        reconciler.recordMeasuredHeight({ signature: thinkingRow(), heightPx: 612 });
        reconciler.recordMeasuredHeight({ signature: thinkingRow(), heightPx: 96 });

        expect(reconciler.resolveReservation(thinkingRow())).toEqual({ kind: 'floor', minHeight: 612 });
    });
});
