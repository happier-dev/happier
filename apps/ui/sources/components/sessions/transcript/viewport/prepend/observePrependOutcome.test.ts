import { describe, expect, it } from 'vitest';

import {
    observePrependOutcome,
    PREPEND_ANCHOR_ALIGNMENT_TOLERANCE_PX,
    type PrependCapturedAnchor,
    type PrependPostCommitObservation,
} from '@/components/sessions/transcript/viewport/prepend/observePrependOutcome';

type Item = Readonly<{ id: string; kind: 'message'; messageId: string }>;

function messageItem(messageId: string): Item {
    return { id: `msg:${messageId}`, kind: 'message', messageId };
}

function capturedAnchor(overrides?: Partial<PrependCapturedAnchor>): PrependCapturedAnchor {
    return {
        key: { itemId: 'msg:m3', messageId: 'm3' },
        itemOffsetPx: 80,
        capturedDataLength: 3,
        capturedFirstItemId: 'msg:m3',
        ...overrides,
    };
}

function postCommit(params: Readonly<{
    items: readonly Item[];
    layoutYByIndex: Readonly<Record<number, number>>;
    absoluteScrollOffset: number;
    contentHeight: number;
    layoutHeight: number;
}>): PrependPostCommitObservation {
    return {
        items: params.items,
        getLayout: (index) => {
            const y = params.layoutYByIndex[index];
            return typeof y === 'number' ? { y } : undefined;
        },
        absoluteScrollOffset: params.absoluteScrollOffset,
        contentHeight: params.contentHeight,
        layoutHeight: params.layoutHeight,
    };
}

describe('observePrependOutcome', () => {
    it('exposes the legacy 4px alignment tolerance as the default', () => {
        expect(PREPEND_ANCHOR_ALIGNMENT_TOLERANCE_PX).toBe(4);
    });

    it('classifies identity-unchanged when no prepend landed (same length, same first item id)', () => {
        const items = [messageItem('m3'), messageItem('m4'), messageItem('m5')];
        const outcome = observePrependOutcome({
            capturedAnchor: capturedAnchor(),
            postCommit: postCommit({
                items,
                layoutYByIndex: { 0: 0, 1: 200, 2: 400 },
                absoluteScrollOffset: 0,
                contentHeight: 600,
                layoutHeight: 300,
            }),
        });
        expect(outcome).toEqual({ kind: 'unresolvable', reason: 'identity-unchanged' });
    });

    it('classifies identity-unchanged when items shrank but the first item id is unchanged', () => {
        const items = [messageItem('m3'), messageItem('m4')];
        const outcome = observePrependOutcome({
            capturedAnchor: capturedAnchor(),
            postCommit: postCommit({
                items,
                layoutYByIndex: { 0: 0, 1: 200 },
                absoluteScrollOffset: 0,
                contentHeight: 400,
                layoutHeight: 300,
            }),
        });
        expect(outcome).toEqual({ kind: 'unresolvable', reason: 'identity-unchanged' });
    });

    it('classifies mvcp-preserved when the anchor item sits within tolerance of its captured viewport offset', () => {
        // Two older items (m1, m2) prepended above; anchor m3 moved to index 2.
        // MVCP shifted scroll so the anchor's viewport offset is preserved: y=900, offset=820 → 80 (captured 80).
        const items = [messageItem('m1'), messageItem('m2'), messageItem('m3'), messageItem('m4'), messageItem('m5')];
        const outcome = observePrependOutcome({
            capturedAnchor: capturedAnchor(),
            postCommit: postCommit({
                items,
                layoutYByIndex: { 0: 0, 1: 450, 2: 900, 3: 1100, 4: 1300 },
                absoluteScrollOffset: 820,
                contentHeight: 1500,
                layoutHeight: 300,
            }),
        });
        expect(outcome.kind).toBe('mvcp-preserved');
    });

    it('treats an observed offset exactly at the tolerance boundary as preserved', () => {
        const items = [messageItem('m1'), messageItem('m3')];
        const outcome = observePrependOutcome({
            capturedAnchor: capturedAnchor({ capturedDataLength: 1, capturedFirstItemId: 'msg:m3' }),
            postCommit: postCommit({
                items,
                layoutYByIndex: { 0: 0, 1: 500 },
                // observed = 500 - 416 = 84 → delta = +4 = tolerance → preserved.
                absoluteScrollOffset: 416,
                contentHeight: 1000,
                layoutHeight: 300,
            }),
            tolerancePx: 4,
        });
        expect(outcome.kind).toBe('mvcp-preserved');
    });

    it('classifies needs-fallback with the single corrective offset when the anchor is misaligned', () => {
        // Anchor m3 at y=900; viewport should put it back at 80px from top → target 820, but MVCP left it at 0.
        const items = [messageItem('m1'), messageItem('m2'), messageItem('m3'), messageItem('m4'), messageItem('m5')];
        const outcome = observePrependOutcome({
            capturedAnchor: capturedAnchor(),
            postCommit: postCommit({
                items,
                layoutYByIndex: { 0: 0, 1: 450, 2: 900, 3: 1100, 4: 1300 },
                absoluteScrollOffset: 0,
                contentHeight: 1500,
                layoutHeight: 300,
            }),
        });
        expect(outcome).toMatchObject({ kind: 'needs-fallback', targetOffsetY: 820 });
    });

    it('clamps the fallback offset to the maximum scrollable offset', () => {
        // target raw = 1450 - 80 = 1370 but max = 1500 - 300 = 1200.
        const items = [messageItem('m1'), messageItem('m3')];
        const outcome = observePrependOutcome({
            capturedAnchor: capturedAnchor({ capturedDataLength: 1, capturedFirstItemId: 'msg:m3' }),
            postCommit: postCommit({
                items,
                layoutYByIndex: { 0: 0, 1: 1450 },
                absoluteScrollOffset: 0,
                contentHeight: 1500,
                layoutHeight: 300,
            }),
        });
        expect(outcome).toMatchObject({ kind: 'needs-fallback', targetOffsetY: 1200 });
    });

    it('honours a custom tolerance parameter', () => {
        const items = [messageItem('m1'), messageItem('m3')];
        const observation = postCommit({
            items,
            // observed = 500 - 410 = 90 → delta = +10.
            layoutYByIndex: { 0: 0, 1: 500 },
            absoluteScrollOffset: 410,
            contentHeight: 1000,
            layoutHeight: 300,
        });
        const anchor = capturedAnchor({ capturedDataLength: 1, capturedFirstItemId: 'msg:m3' });

        expect(observePrependOutcome({ capturedAnchor: anchor, postCommit: observation, tolerancePx: 16 }).kind)
            .toBe('mvcp-preserved');
        expect(observePrependOutcome({ capturedAnchor: anchor, postCommit: observation, tolerancePx: 4 }).kind)
            .toBe('needs-fallback');
    });

    it('resolves the anchor by messageId when the item id changed across re-grouping', () => {
        // Prepend re-grouping can re-id the containing item; messageId containment must still resolve.
        const items = [
            messageItem('m1'),
            { id: 'msg:renamed', kind: 'message', messageId: 'm3' } satisfies Item,
        ];
        const outcome = observePrependOutcome({
            capturedAnchor: capturedAnchor({ capturedDataLength: 1, capturedFirstItemId: 'msg:m3' }),
            postCommit: postCommit({
                items,
                layoutYByIndex: { 0: 0, 1: 500 },
                absoluteScrollOffset: 420,
                contentHeight: 1000,
                layoutHeight: 300,
            }),
        });
        expect(outcome.kind).toBe('mvcp-preserved');
    });

    it('proceeds to anchor resolution when length is unchanged but the first item id changed (headless-turn merge)', () => {
        // C3 merge shape: a prepend absorbed into the headless first turn keeps the item count but
        // re-ids the first item. This must NOT read as identity-unchanged; messageId containment
        // still resolves the anchor.
        const items = [
            { id: 'turn:merged', kind: 'message', messageId: 'm3' } satisfies Item,
            messageItem('m4'),
            messageItem('m5'),
        ];
        const outcome = observePrependOutcome({
            capturedAnchor: capturedAnchor(),
            postCommit: postCommit({
                items,
                // observed = 100 - 20 = 80 = captured offset → preserved.
                layoutYByIndex: { 0: 100, 1: 400, 2: 600 },
                absoluteScrollOffset: 20,
                contentHeight: 900,
                layoutHeight: 300,
            }),
        });
        expect(outcome.kind).toBe('mvcp-preserved');
    });

    it('classifies anchor-missing for empty committed items instead of identity-unchanged', () => {
        const outcome = observePrependOutcome({
            capturedAnchor: capturedAnchor(),
            postCommit: postCommit({
                items: [],
                layoutYByIndex: {},
                absoluteScrollOffset: 0,
                contentHeight: 0,
                layoutHeight: 300,
            }),
        });
        expect(outcome).toEqual({ kind: 'unresolvable', reason: 'anchor-missing' });
    });

    it('classifies identity-unchanged when both the capture and the observation have no items', () => {
        const outcome = observePrependOutcome({
            capturedAnchor: capturedAnchor({ capturedDataLength: 0, capturedFirstItemId: null }),
            postCommit: postCommit({
                items: [],
                layoutYByIndex: {},
                absoluteScrollOffset: 0,
                contentHeight: 0,
                layoutHeight: 300,
            }),
        });
        expect(outcome).toEqual({ kind: 'unresolvable', reason: 'identity-unchanged' });
    });

    it('classifies anchor-missing when neither the message nor the item id survives', () => {
        const items = [messageItem('m1'), messageItem('m2')];
        const outcome = observePrependOutcome({
            capturedAnchor: capturedAnchor({ capturedDataLength: 1, capturedFirstItemId: 'msg:m9' }),
            postCommit: postCommit({
                items,
                layoutYByIndex: { 0: 0, 1: 500 },
                absoluteScrollOffset: 0,
                contentHeight: 1000,
                layoutHeight: 300,
            }),
        });
        expect(outcome).toEqual({ kind: 'unresolvable', reason: 'anchor-missing' });
    });

    it('classifies layout-not-ready when the anchor item has no measured layout yet', () => {
        const items = [messageItem('m1'), messageItem('m3')];
        const outcome = observePrependOutcome({
            capturedAnchor: capturedAnchor({ capturedDataLength: 1, capturedFirstItemId: 'msg:m3' }),
            postCommit: postCommit({
                items,
                layoutYByIndex: { 0: 0 },
                absoluteScrollOffset: 0,
                contentHeight: 1000,
                layoutHeight: 300,
            }),
        });
        expect(outcome).toEqual({ kind: 'unresolvable', reason: 'layout-not-ready' });
    });

    it('classifies layout-not-ready when the absolute scroll offset is not finite', () => {
        const items = [messageItem('m1'), messageItem('m3')];
        const outcome = observePrependOutcome({
            capturedAnchor: capturedAnchor({ capturedDataLength: 1, capturedFirstItemId: 'msg:m3' }),
            postCommit: postCommit({
                items,
                layoutYByIndex: { 0: 0, 1: 500 },
                absoluteScrollOffset: Number.NaN,
                contentHeight: 1000,
                layoutHeight: 300,
            }),
        });
        expect(outcome).toEqual({ kind: 'unresolvable', reason: 'layout-not-ready' });
    });

    it('classifies layout-not-ready when a misaligned anchor cannot produce a valid corrective offset', () => {
        // Misaligned but content does not scroll (contentHeight <= layoutHeight) → no valid write target.
        const items = [messageItem('m1'), messageItem('m3')];
        const outcome = observePrependOutcome({
            capturedAnchor: capturedAnchor({ capturedDataLength: 1, capturedFirstItemId: 'msg:m3' }),
            postCommit: postCommit({
                items,
                layoutYByIndex: { 0: 0, 1: 150 },
                absoluteScrollOffset: 0,
                contentHeight: 250,
                layoutHeight: 300,
            }),
        });
        expect(outcome).toEqual({ kind: 'unresolvable', reason: 'layout-not-ready' });
    });
});
