import { describe, expect, it } from 'vitest';

import { createTestTranscriptMeasurementReconciler, isStructuralSignatureDelta } from './transcriptMeasurementReconciler';
import type { TranscriptItemHeightValiditySignature } from './transcriptItemHeightCache';

function streamingSignature(
    overrides: Partial<TranscriptItemHeightValiditySignature> = {},
): TranscriptItemHeightValiditySignature {
    return {
        itemId: 'message-1',
        kind: 'message:agent',
        structuralKey: 'message-1:content-v1',
        widthBucket: 'width:400',
        fontScaleKey: 'font:1',
        groupingMode: 'turn',
        forkContextKey: 'root',
        expansionKey: 'tools:none|thinking:none',
        rowState: 'streaming',
        ...overrides,
    };
}

function stableSignature(
    overrides: Partial<TranscriptItemHeightValiditySignature> = {},
): TranscriptItemHeightValiditySignature {
    return streamingSignature({ rowState: 'stable', ...overrides });
}

describe('transcriptMeasurementReconciler', () => {
    describe('resolveRecycleType is shape-stable across a stream (T2)', () => {
        it('returns the same recycle type for an agent message growing past the long-text threshold', () => {
            const reconciler = createTestTranscriptMeasurementReconciler();
            const short = streamingSignature({ structuralKey: 'message-1:a'.repeat(1) });
            const long = streamingSignature({ structuralKey: 'message-1:a'.repeat(4096) });

            expect(reconciler.resolveRecycleType(short)).toBe('message:agent');
            expect(reconciler.resolveRecycleType(long)).toBe('message:agent');
            expect(reconciler.resolveRecycleType(short)).toBe(reconciler.resolveRecycleType(long));
        });

        it('does not flip the recycle type as a streaming row transitions to stable', () => {
            const reconciler = createTestTranscriptMeasurementReconciler();
            const streaming = streamingSignature();
            const stable = stableSignature();

            expect(reconciler.resolveRecycleType(streaming)).toBe(reconciler.resolveRecycleType(stable));
        });
    });

    describe('streaming floor is monotonic and never over-reserves (T1)', () => {
        it('raises the floor with each larger measured height and never reports below the last height', () => {
            const reconciler = createTestTranscriptMeasurementReconciler();
            const signature = streamingSignature();

            for (const heightPx of [120, 180, 240]) {
                reconciler.recordMeasuredHeight({ signature, heightPx });
            }

            const reservation = reconciler.resolveReservation(signature);
            expect(reservation).toEqual({ kind: 'floor', minHeight: 240 });
        });

        it('keeps the floor at the peak when a later measurement is smaller within the same shape', () => {
            const reconciler = createTestTranscriptMeasurementReconciler();
            const signature = streamingSignature();

            reconciler.recordMeasuredHeight({ signature, heightPx: 240 });
            reconciler.recordMeasuredHeight({ signature, heightPx: 180 });

            expect(reconciler.resolveReservation(signature)).toEqual({ kind: 'floor', minHeight: 240 });
        });

        it('returns undefined for a streaming row that has never been measured and has no per-type sample', () => {
            const reconciler = createTestTranscriptMeasurementReconciler();
            expect(reconciler.resolveReservation(streamingSignature())).toBeUndefined();
        });
    });

    describe('the floor resets on structural change (collapse/shrink)', () => {
        it('drops the floor on a structural reset so a collapse leaves no persistent over-reservation', () => {
            const reconciler = createTestTranscriptMeasurementReconciler();
            const expanded = streamingSignature({ expansionKey: 'tools:expanded|thinking:none' });
            reconciler.recordMeasuredHeight({ signature: expanded, heightPx: 240 });
            expect(reconciler.resolveReservation(expanded)).toEqual({ kind: 'floor', minHeight: 240 });

            const collapsed = streamingSignature({ expansionKey: 'tools:collapsed|thinking:none' });
            reconciler.resetReservationForStructuralChange({ itemId: collapsed.itemId, signature: collapsed });

            const reservation = reconciler.resolveReservation(collapsed);
            expect(reservation === undefined || reservation.minHeight < 240).toBe(true);
        });
    });

    describe('the floor key is width/font scoped (T0 geometry)', () => {
        it('survives content-revision churn but misses on a width change', () => {
            const reconciler = createTestTranscriptMeasurementReconciler();
            const atWidth400 = streamingSignature({ widthBucket: 'width:400' });
            reconciler.recordMeasuredHeight({ signature: atWidth400, heightPx: 200 });

            const tokenChurn = streamingSignature({ widthBucket: 'width:400', structuralKey: 'message-1:content-v9' });
            expect(reconciler.resolveReservation(tokenChurn)).toEqual({ kind: 'floor', minHeight: 200 });

            const atWidth640 = streamingSignature({ widthBucket: 'width:640' });
            const reservationAtNewWidth = reconciler.resolveReservation(atWidth640);
            expect(reservationAtNewWidth === undefined || reservationAtNewWidth.minHeight !== 200).toBe(true);
        });
    });

    describe('first-seen rows reserve NOTHING — no per-type median over-reservation (C1 over-reservation fix)', () => {
        it('reserves undefined for a never-measured row even when other rows of the same shape-type were measured', () => {
            // Regression for the over-reservation bug: shape-only getItemType merges short+long agent
            // rows into one recycle type, so a per-type median would force-reserve a short first-seen
            // row too tall — and a content `minHeight` is self-fulfilling (onLayout measures the forced
            // height), so it never recovers. A first-seen row must reserve NOTHING and measure naturally.
            const reconciler = createTestTranscriptMeasurementReconciler();
            for (const itemId of ['agent-a', 'agent-b', 'agent-c']) {
                reconciler.recordMeasuredHeight({
                    signature: stableSignature({ itemId, kind: 'message:agent' }),
                    heightPx: 150,
                });
            }

            const newRow = streamingSignature({ itemId: 'agent-new', kind: 'message:agent', structuralKey: 'agent-new:v1' });
            expect(reconciler.resolveReservation(newRow)).toBeUndefined();
        });

        it('returns undefined for a never-measured row with no prior measurements', () => {
            const reconciler = createTestTranscriptMeasurementReconciler();
            const newRow = streamingSignature({ itemId: 'agent-new', kind: 'message:agent' });
            expect(reconciler.resolveReservation(newRow)).toBeUndefined();
        });
    });

    describe('exact reservation for stable rows (composes the height cache)', () => {
        it('returns an exact reservation equal to the last measured height for a stable row', () => {
            const reconciler = createTestTranscriptMeasurementReconciler();
            const signature = stableSignature();
            reconciler.recordMeasuredHeight({ signature, heightPx: 168 });

            expect(reconciler.resolveReservation(signature)).toEqual({ kind: 'exact', minHeight: 168 });
        });

        it('never serves a stale exact height when the stable content revision changes', () => {
            const reconciler = createTestTranscriptMeasurementReconciler();
            reconciler.recordMeasuredHeight({ signature: stableSignature({ structuralKey: 'v1' }), heightPx: 168 });

            const changed = stableSignature({ structuralKey: 'v2' });
            const reservation = reconciler.resolveReservation(changed);
            expect(reservation === undefined || reservation.kind === 'floor').toBe(true);
        });
    });

    describe('session lifecycle reset', () => {
        it('drops floors on resetForSession', () => {
            const reconciler = createTestTranscriptMeasurementReconciler();
            const signature = streamingSignature();
            reconciler.recordMeasuredHeight({ signature, heightPx: 240 });
            expect(reconciler.resolveReservation(signature)).toEqual({ kind: 'floor', minHeight: 240 });

            reconciler.resetForSession('next-session');

            expect(reconciler.resolveReservation(signature)).toBeUndefined();
        });
    });

    describe('fail-safe reservation', () => {
        it('ignores non-finite or non-positive measured heights', () => {
            const reconciler = createTestTranscriptMeasurementReconciler();
            const signature = streamingSignature();
            reconciler.recordMeasuredHeight({ signature, heightPx: Number.NaN });
            reconciler.recordMeasuredHeight({ signature, heightPx: 0 });
            reconciler.recordMeasuredHeight({ signature, heightPx: -10 });

            expect(reconciler.resolveReservation(signature)).toBeUndefined();
        });
    });
});

describe('isStructuralSignatureDelta (per-item floor reset trigger)', () => {
    const toolGroupHeader = (status: 'running' | 'completed'): TranscriptItemHeightValiditySignature =>
        stableSignature({
            itemId: 'group-1#header',
            kind: 'tool-group-header',
            structuralKey: `group-1|count:2|status:${status}|expanded:false`,
            expansionKey: 'tools:collapsed|thinking:none',
        });

    it('re-seeds a settled tool-group header when its status changes running→completed (the shrink that left the gap)', () => {
        expect(isStructuralSignatureDelta(toolGroupHeader('running'), toolGroupHeader('completed'))).toBe(true);
    });

    it('does not re-seed a settled row whose content is unchanged', () => {
        expect(isStructuralSignatureDelta(toolGroupHeader('completed'), toolGroupHeader('completed'))).toBe(false);
    });

    it('does NOT re-seed while a row streams (its monotonic floor must prevent append overlap)', () => {
        const a = streamingSignature({ structuralKey: 'message-1:tok-10' });
        const b = streamingSignature({ structuralKey: 'message-1:tok-20' });
        expect(isStructuralSignatureDelta(a, b)).toBe(false);
    });

    it('DOES re-seed a tool-progress row on content change — REFUTES the earlier "excluded like streaming" premise', () => {
        // Re-authored 2026-07-27 (E-3 / RC-P). This case previously asserted `false`, on the premise
        // that a growing `tool-progress` row needs its monotonic floor the way a streaming row does.
        // That premise is refuted: a `minHeight` is INERT for a growing row — it binds only BELOW
        // natural height, so the floor never protected growth at all. What the exclusion actually did
        // was strand the tallest historical height on every row family whose rowState stays constant
        // at a non-growing value while its content SHRINKS (`tool-progress`, `pending-action`), where
        // the `minHeight` then self-fulfils: the row stays physically tall and the next row's `top` is
        // derived from the inflated height. Only `streaming` and `thinking` are genuinely growing.
        // Do not re-introduce the exclusion.
        const a = stableSignature({ rowState: 'tool-progress', structuralKey: 'tool-1:out-10' });
        const b = stableSignature({ rowState: 'tool-progress', structuralKey: 'tool-1:out-20' });
        expect(isStructuralSignatureDelta(a, b)).toBe(true);
    });

    it('re-seeds a pending-action row on a content change (a draining queue is shrink-capable)', () => {
        const a = stableSignature({ rowState: 'pending-action', structuralKey: 'pending-queue|count:3' });
        const b = stableSignature({ rowState: 'pending-action', structuralKey: 'pending-queue|count:1' });
        expect(isStructuralSignatureDelta(a, b)).toBe(true);
    });

    it('does NOT re-seed a growing thinking row on a content change (thinking is a GROWING state)', () => {
        // `resolveMessageRowState` returns 'thinking' BEFORE any streaming branch, so a genuinely
        // growing thinking block reports 'thinking', never 'streaming'. It must stay in the growing set.
        const a = stableSignature({ rowState: 'thinking', structuralKey: 'thinking-1:r9' });
        const b = stableSignature({ rowState: 'thinking', structuralKey: 'thinking-1:r10' });
        expect(isStructuralSignatureDelta(a, b)).toBe(false);
    });

    it('re-seeds when only ONE side is growing and the structural shape changed', () => {
        expect(isStructuralSignatureDelta(
            stableSignature({ rowState: 'thinking', structuralKey: 'thinking-1:r9' }),
            stableSignature({ rowState: 'stable', structuralKey: 'thinking-1:r10' }),
        )).toBe(true);
    });

    it('re-seeds on a streaming→stable finalize (rowState change)', () => {
        expect(isStructuralSignatureDelta(streamingSignature(), stableSignature())).toBe(true);
    });

    it('re-seeds on expand/collapse', () => {
        expect(isStructuralSignatureDelta(
            stableSignature({ expansionKey: 'tools:collapsed|thinking:none' }),
            stableSignature({ expansionKey: 'tools:expanded|thinking:none' }),
        )).toBe(true);
    });
});

describe('per-item floor re-seeds after a settled shrink (tool-group header gap fix, end-to-end)', () => {
    it('drops the stale taller floor once the header structural change triggers a reset', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();
        const running = stableSignature({
            itemId: 'group-1#header', kind: 'tool-group-header',
            structuralKey: 'group-1|status:running', expansionKey: 'tools:collapsed|thinking:none',
        });
        const completed = stableSignature({
            itemId: 'group-1#header', kind: 'tool-group-header',
            structuralKey: 'group-1|status:completed', expansionKey: 'tools:collapsed|thinking:none',
        });

        // Running header measured tall (e.g. 36px with the running indicator).
        reconciler.recordMeasuredHeight({ signature: running, heightPx: 36 });

        // The completed header (a different structuralKey) misses the exact cache. It used to
        // inherit the running floor here — the stale 36 over-reservation whose self-fulfilling
        // minHeight produced the persistent gap. E-3 M2 gates SERVING on the shape the floor was
        // recorded from, so a shrink-capable row never inherits it, even before any reset can fire.
        expect(reconciler.resolveReservation(completed)).toBeUndefined();

        // The shell fires the reset because the settled header's structuralKey changed.
        expect(isStructuralSignatureDelta(running, completed)).toBe(true);
        reconciler.resetReservationForStructuralChange({ itemId: 'group-1#header', signature: completed });

        // Reset-pending: no reservation is served, so the row measures its natural (shorter) height.
        expect(reconciler.resolveReservation(completed)).toBeUndefined();

        // The natural completed height re-seeds the reservation — no more 36px over-reservation.
        reconciler.recordMeasuredHeight({ signature: completed, heightPx: 33 });
        expect(reconciler.resolveReservation(completed)).toEqual({ kind: 'exact', minHeight: 33 });
    });
});

/**
 * E-3 (RC-C + RC-P). A stale height floor stranded EVERY shrink-capable row family, not just the
 * pending queue: the reset predicate only fired between two `stable` rows, and the floor was served
 * on mount before any delta check could run. Shrink-capable = every rowState except the genuinely
 * growing `{ 'streaming', 'thinking' }`.
 */
describe('E-3 · every shrink-capable row releases its stale floor (RC-C + RC-P)', () => {
    function pendingQueueSignature(
        count: number,
        overrides: Partial<TranscriptItemHeightValiditySignature> = {},
    ): TranscriptItemHeightValiditySignature {
        // `chatListItems.ts` gives the queue row the FIXED id 'pending-queue', so its floor key is
        // constant for the whole session at a given width/font — across drains AND across sends.
        return stableSignature({
            itemId: 'pending-queue',
            kind: 'pending-action',
            structuralKey: `pending-queue|count:${count}`,
            rowState: 'pending-action',
            ...overrides,
        });
    }

    function toolProgressSignature(
        structuralKey: string,
        overrides: Partial<TranscriptItemHeightValiditySignature> = {},
    ): TranscriptItemHeightValiditySignature {
        return stableSignature({
            itemId: 'group-1#tool:tool-1',
            kind: 'tool-group-tool',
            structuralKey,
            expansionKey: 'tools:collapsed|thinking:none',
            rowState: 'tool-progress',
            ...overrides,
        });
    }

    /** Mirrors `TranscriptRowShell`: the layout effect resets on a delta, then onLayout records. */
    function commitRowFrame(
        reconciler: ReturnType<typeof createTestTranscriptMeasurementReconciler>,
        params: Readonly<{
            previous?: TranscriptItemHeightValiditySignature;
            next: TranscriptItemHeightValiditySignature;
            measuredHeightPx: number;
        }>,
    ): void {
        if (params.previous !== undefined && isStructuralSignatureDelta(params.previous, params.next)) {
            reconciler.resetReservationForStructuralChange({ itemId: params.next.itemId, signature: params.next });
        }
        reconciler.recordMeasuredHeight({ signature: params.next, heightPx: params.measuredHeightPx });
    }

    it('(a) DECREASES the pending-queue reservation when the queue drains 3 -> 1', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();
        commitRowFrame(reconciler, { next: pendingQueueSignature(3), measuredHeightPx: 120 });
        expect(reconciler.resolveReservation(pendingQueueSignature(3))).toEqual({ kind: 'floor', minHeight: 120 });

        commitRowFrame(reconciler, {
            previous: pendingQueueSignature(3),
            next: pendingQueueSignature(1),
            measuredHeightPx: 44,
        });

        expect(reconciler.resolveReservation(pendingQueueSignature(1))).toEqual({ kind: 'floor', minHeight: 44 });
    });

    it('(b) does not inherit the tall queue floor across a 3 -> 0 -> 1 remount', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();
        commitRowFrame(reconciler, { next: pendingQueueSignature(3), measuredHeightPx: 120 });

        // The row unmounts at count 0 and remounts at count 1. `TranscriptRowShell` initialises both
        // signature refs to the CURRENT signature, so `previousSignature` is `undefined` by
        // construction on the first render and NO delta check can run — only serve-gating reaches this.
        const remounted = pendingQueueSignature(1);
        expect(reconciler.resolveReservation(remounted)).toBeUndefined();

        reconciler.recordMeasuredHeight({ signature: remounted, heightPx: 44 });
        expect(reconciler.resolveReservation(remounted)).toEqual({ kind: 'floor', minHeight: 44 });
    });

    it('(c) does not let a second send inherit the first send\'s tallest queue floor', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();
        commitRowFrame(reconciler, { next: pendingQueueSignature(3), measuredHeightPx: 132 });

        const secondSend = pendingQueueSignature(1, { structuralKey: 'pending-queue|send:2|count:1' });
        expect(reconciler.resolveReservation(secondSend)).toBeUndefined();

        reconciler.recordMeasuredHeight({ signature: secondSend, heightPx: 48 });
        expect(reconciler.resolveReservation(secondSend)).toEqual({ kind: 'floor', minHeight: 48 });
    });

    it('(d) releases a still-running tool row floor when its preview shrinks', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();
        commitRowFrame(reconciler, { next: toolProgressSignature('tool-1:r10'), measuredHeightPx: 220 });

        commitRowFrame(reconciler, {
            previous: toolProgressSignature('tool-1:r10'),
            next: toolProgressSignature('tool-1:r11'),
            measuredHeightPx: 64,
        });

        expect(reconciler.resolveReservation(toolProgressSignature('tool-1:r11'))).toEqual({ kind: 'floor', minHeight: 64 });
    });

    it('(e) releases the floor on a permission_pending -> running collapse (rowState does NOT change)', () => {
        // `resolveToolStatusIndicatorKind` maps BOTH 'running' and 'permission_pending' to
        // 'tool-progress', so granting a permission collapses a tall prompt row into a short running
        // row with NO rowState change — only `structuralKey` moves. Every rowState/expansion/geometry
        // check misses it.
        const reconciler = createTestTranscriptMeasurementReconciler();
        const prompting = toolProgressSignature('tool-1:r7');
        const running = toolProgressSignature('tool-1:r8');
        expect(prompting.rowState).toBe(running.rowState);

        commitRowFrame(reconciler, { next: prompting, measuredHeightPx: 260 });
        commitRowFrame(reconciler, { previous: prompting, next: running, measuredHeightPx: 52 });

        expect(reconciler.resolveReservation(running)).toEqual({ kind: 'floor', minHeight: 52 });
    });

    it('(f) releases the floor when a running tool completes (tool-progress -> stable)', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();
        const running = toolProgressSignature('tool-1:r4');
        const completed = toolProgressSignature('tool-1:r5', { rowState: 'stable' });

        commitRowFrame(reconciler, { next: running, measuredHeightPx: 180 });
        commitRowFrame(reconciler, { previous: running, next: completed, measuredHeightPx: 56 });

        expect(reconciler.resolveReservation(completed)).toEqual({ kind: 'exact', minHeight: 56 });
    });

    it('(g) releases the floor when a running tool row collapses from expanded to collapsed', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();
        const expanded = toolProgressSignature('tool-1:r4', { expansionKey: 'tools:expanded|thinking:none' });
        const collapsed = toolProgressSignature('tool-1:r4', { expansionKey: 'tools:collapsed|thinking:none' });

        commitRowFrame(reconciler, { next: expanded, measuredHeightPx: 420 });
        commitRowFrame(reconciler, { previous: expanded, next: collapsed, measuredHeightPx: 40 });

        expect(reconciler.resolveReservation(collapsed)).toEqual({ kind: 'floor', minHeight: 40 });
    });

    it('(h) releases a thinking block floor once the block settles', () => {
        // The rowState ASSIGNMENT half of this contract lives in `transcriptRowShellSignature`
        // (a settled thinking block must stop reporting 'thinking'); this pins the reconciler half.
        const reconciler = createTestTranscriptMeasurementReconciler();
        const growing = stableSignature({
            itemId: 'thinking-1', kind: 'message:thinking',
            structuralKey: 'thinking-1:r9', rowState: 'thinking',
        });
        const settled = stableSignature({
            itemId: 'thinking-1', kind: 'message:thinking',
            structuralKey: 'thinking-1:r10', rowState: 'stable',
        });

        commitRowFrame(reconciler, { next: growing, measuredHeightPx: 640 });
        commitRowFrame(reconciler, { previous: growing, next: settled, measuredHeightPx: 96 });

        expect(reconciler.resolveReservation(settled)).toEqual({ kind: 'exact', minHeight: 96 });
    });

    it('(i) WIDTH-BUCKET CYCLE: returning to the original width does not re-serve the stale floor', () => {
        // The floor key is `itemId|widthBucket|fontScaleKey`, so a viewport resize moves every row to
        // a fresh key where nothing stale exists — which is exactly why docking DevTools "fixes" the
        // symptom, and why returning to the original width brings it back. A virtualized row that is
        // not mounted during the resize never gets a delta check at all.
        const reconciler = createTestTranscriptMeasurementReconciler();
        const wideTall = toolProgressSignature('tool-1:r1', { widthBucket: 'width:1200' });
        reconciler.recordMeasuredHeight({ signature: wideTall, heightPx: 300 });

        // Content shrinks; the viewport then narrows before this row renders again.
        const narrowShort = toolProgressSignature('tool-1:r2', { widthBucket: 'width:600' });
        expect(reconciler.resolveReservation(narrowShort)).toBeUndefined();
        reconciler.recordMeasuredHeight({ signature: narrowShort, heightPx: 88 });

        // Back to width A with the shrunken content: the stale 300 floor must NOT be re-served.
        const wideShort = toolProgressSignature('tool-1:r2', { widthBucket: 'width:1200' });
        expect(reconciler.resolveReservation(wideShort)).toBeUndefined();
    });

    it('(j) MOUNT INHERITANCE: a fresh mount at a warm width never serves the previous visit\'s floor', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();
        const firstVisit = toolProgressSignature('tool-1:r1');
        reconciler.recordMeasuredHeight({ signature: firstVisit, heightPx: 512 });

        // Reopening the session remounts the row with settled, shorter content at the same width.
        const secondVisit = toolProgressSignature('tool-1:r6', { rowState: 'stable' });
        expect(reconciler.resolveReservation(secondVisit)).toBeUndefined();

        reconciler.recordMeasuredHeight({ signature: secondVisit, heightPx: 72 });
        expect(reconciler.resolveReservation(secondVisit)).toEqual({ kind: 'exact', minHeight: 72 });
    });

    it('NEGATIVE: a growing streaming row keeps its monotonic floor across structuralKey churn', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();
        const early = streamingSignature({ structuralKey: 'message-1:tok-10' });
        const later = streamingSignature({ structuralKey: 'message-1:tok-20' });

        commitRowFrame(reconciler, { next: early, measuredHeightPx: 240 });
        expect(isStructuralSignatureDelta(early, later)).toBe(false);
        expect(reconciler.resolveReservation(later)).toEqual({ kind: 'floor', minHeight: 240 });
    });

    it('NEGATIVE: a growing thinking row keeps its monotonic floor across structuralKey churn', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();
        const early = streamingSignature({
            itemId: 'thinking-1', kind: 'message:thinking',
            structuralKey: 'thinking-1:r9', rowState: 'thinking',
        });
        const later = streamingSignature({
            itemId: 'thinking-1', kind: 'message:thinking',
            structuralKey: 'thinking-1:r10', rowState: 'thinking',
        });

        commitRowFrame(reconciler, { next: early, measuredHeightPx: 512 });
        expect(isStructuralSignatureDelta(early, later)).toBe(false);
        expect(reconciler.resolveReservation(later)).toEqual({ kind: 'floor', minHeight: 512 });
    });

    it('NEGATIVE: an unchanged shrink-capable row keeps serving its own floor', () => {
        const reconciler = createTestTranscriptMeasurementReconciler();
        const signature = toolProgressSignature('tool-1:r3');
        reconciler.recordMeasuredHeight({ signature, heightPx: 210 });
        reconciler.recordMeasuredHeight({ signature, heightPx: 190 });

        expect(reconciler.resolveReservation(signature)).toEqual({ kind: 'floor', minHeight: 210 });
    });
});
