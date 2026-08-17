import { describe, expect, it } from 'vitest';

import { resolveTranscriptViewportAnchorIndex } from '@/components/sessions/transcript/viewport/entryRestore/transcriptViewportAnchorResolution';
import {
    resolveEntryRestoreTarget,
    type EntryRestoreAnchorSnapshot,
    type ResolveEntryRestoreTargetParams,
} from './resolveEntryRestoreTarget';

type TestItem = Readonly<{
    id: string;
    kind: 'message' | 'tool-calls-group' | 'fork-divider';
    messageId?: string;
    toolMessageIds?: string[];
    seq?: number;
}>;

const loadedItems: readonly TestItem[] = [
    { id: 'msg:m-10', kind: 'message', messageId: 'm-10', seq: 10 },
    { id: 'msg:m-20', kind: 'message', messageId: 'm-20', seq: 20 },
    { id: 'tools:m-30', kind: 'tool-calls-group', toolMessageIds: ['m-30'], seq: 30 },
    { id: 'msg:m-40', kind: 'message', messageId: 'm-40', seq: 40 },
];

const anchorSeqByMessageId: Readonly<Record<string, number>> = {
    'm-3': 3,
    'm-10': 10,
    'm-20': 20,
    'm-25': 25,
    'm-30': 30,
    'm-40': 40,
};

function resolveAnchorIndex(anchor: EntryRestoreAnchorSnapshot, items: readonly TestItem[]): number | null {
    return resolveTranscriptViewportAnchorIndex({ anchor, items });
}

function resolveNearestSurvivingIndex(anchor: EntryRestoreAnchorSnapshot, items: readonly TestItem[]): number | null {
    const anchorSeq = anchor.messageId ? anchorSeqByMessageId[anchor.messageId] : undefined;
    if (anchorSeq == null) return null;

    let earlier: { index: number; seq: number } | null = null;
    let later: { index: number; seq: number } | null = null;
    for (let index = 0; index < items.length; index += 1) {
        const item = items[index]!;
        if (item.seq == null) continue;
        if (item.seq < anchorSeq) {
            if (!earlier || item.seq > earlier.seq) earlier = { index, seq: item.seq };
            continue;
        }
        if (item.seq > anchorSeq) {
            if (!later || item.seq < later.seq) later = { index, seq: item.seq };
        }
    }
    return (earlier ?? later)?.index ?? null;
}

function buildParams(
    overrides: Partial<ResolveEntryRestoreTargetParams<TestItem>> = {},
): ResolveEntryRestoreTargetParams<TestItem> {
    return {
        snapshot: {
            shouldFollowBottom: false,
            offsetY: 600,
            anchor: null,
        },
        items: loadedItems,
        contentMeasured: { contentHeight: 4000, layoutHeight: 800 },
        fillSettled: true,
        canMaterializeOlder: false,
        anchorIndexResolver: resolveAnchorIndex,
        nearestSurvivingResolver: resolveNearestSurvivingIndex,
        ...overrides,
    };
}

describe('resolve entry restore target', () => {
    it('resolves a present anchor to its item index with the stored view offset', () => {
        expect(resolveEntryRestoreTarget(buildParams({
            snapshot: {
                shouldFollowBottom: false,
                offsetY: 600,
                anchor: { itemId: 'msg:m-20', messageId: 'm-20', itemOffsetPx: 84 },
            },
        }))).toEqual({ kind: 'anchor', index: 1, itemOffsetPx: 84 });
    });

    it('falls back to the nearest surviving item when the anchor message was pruned', () => {
        expect(resolveEntryRestoreTarget(buildParams({
            snapshot: {
                shouldFollowBottom: false,
                offsetY: 600,
                anchor: { itemId: 'msg:m-25', messageId: 'm-25', itemOffsetPx: 48 },
            },
            canMaterializeOlder: false,
        }))).toEqual({ kind: 'anchor', index: 1, itemOffsetPx: 48 });
    });

    it('requests bounded materialization while the anchor may live in an unloaded older region', () => {
        const snapshot = {
            shouldFollowBottom: false,
            offsetY: 600,
            anchor: { itemId: 'msg:m-3', messageId: 'm-3', itemOffsetPx: 12 },
        };

        expect(resolveEntryRestoreTarget(buildParams({
            snapshot,
            canMaterializeOlder: true,
            anchorSeqResolver: (anchor) => (anchor.messageId ? anchorSeqByMessageId[anchor.messageId] ?? null : null),
        }))).toEqual({ kind: 'materialize-then-anchor', anchorSeqHint: 3 });

        expect(resolveEntryRestoreTarget(buildParams({
            snapshot: {
                ...snapshot,
                anchor: { ...snapshot.anchor, seq: 3 },
            },
            canMaterializeOlder: true,
        }))).toEqual({ kind: 'materialize-then-anchor', anchorSeqHint: 3 });
    });

    it('does not materialize older pages when the durable anchor seq is already inside the loaded range', () => {
        expect(resolveEntryRestoreTarget(buildParams({
            snapshot: {
                shouldFollowBottom: false,
                offsetY: 420,
                anchor: {
                    itemId: 'toolCalls:turn:runtime#header',
                    itemOffsetPx: 26,
                    messageId: 'rotated-runtime-id',
                    seq: 25,
                },
            },
            canMaterializeOlder: true,
            anchorIndexResolver: () => null,
            anchorSeqLoadedResolver: () => true,
            nearestSurvivingResolver: () => 1,
        }))).toEqual({ kind: 'anchor', index: 1, itemOffsetPx: 26 });
    });

    it('does not materialize an unresolvable anchor without a durable seq hint', () => {
        expect(resolveEntryRestoreTarget(buildParams({
            snapshot: {
                shouldFollowBottom: false,
                offsetY: 900,
                anchor: { itemId: 'runtime-tool-group', messageId: 'rotated-tool-id', itemOffsetPx: 24 },
            },
            canMaterializeOlder: true,
            fillSettled: true,
        }))).toEqual({ kind: 'distance-oneshot', targetOffsetY: 2300 });
    });

    it('treats seq zero on an unresolvable anchor as missing durable seq', () => {
        expect(resolveEntryRestoreTarget(buildParams({
            snapshot: {
                shouldFollowBottom: false,
                offsetY: 900,
                anchor: { itemId: 'runtime-tool-group', messageId: 'rotated-tool-id', itemOffsetPx: 24, seq: 0 },
            },
            canMaterializeOlder: true,
            fillSettled: true,
        }))).toEqual({ kind: 'distance-oneshot', targetOffsetY: 2300 });
    });

    it('restores by one-shot distance only after the initial fill settles', () => {
        expect(resolveEntryRestoreTarget(buildParams({
            fillSettled: false,
        }))).toEqual({ kind: 'none', reason: 'awaiting-fill-settle' });

        expect(resolveEntryRestoreTarget(buildParams({
            fillSettled: true,
        }))).toEqual({ kind: 'distance-oneshot', targetOffsetY: 2600 });
    });

    it('clamps a one-shot distance target into the scrollable range', () => {
        expect(resolveEntryRestoreTarget(buildParams({
            snapshot: { shouldFollowBottom: false, offsetY: 5000, anchor: null },
        }))).toEqual({ kind: 'distance-oneshot', targetOffsetY: 0 });
    });

    it('does not synthesize a bottom restore when the restored distance is unknown', () => {
        expect(resolveEntryRestoreTarget(buildParams({
            snapshot: { shouldFollowBottom: false, offsetY: null, anchor: null },
            fillSettled: true,
        }))).toEqual({ kind: 'none', reason: 'missing-restored-distance' });
    });

    it('waits for content measurement before issuing a one-shot distance target', () => {
        expect(resolveEntryRestoreTarget(buildParams({
            contentMeasured: { contentHeight: 0, layoutHeight: 0 },
        }))).toEqual({ kind: 'none', reason: 'content-unmeasured' });
    });

    it('uses the unresolvable-anchor distance fallback only once fill settles', () => {
        const snapshot = {
            shouldFollowBottom: false,
            offsetY: 900,
            anchor: { itemId: 'msg:m-99', messageId: 'm-99', itemOffsetPx: 24 },
        };

        expect(resolveEntryRestoreTarget(buildParams({
            snapshot,
            fillSettled: false,
        }))).toEqual({ kind: 'none', reason: 'awaiting-fill-settle' });

        expect(resolveEntryRestoreTarget(buildParams({
            snapshot,
            fillSettled: true,
        }))).toEqual({ kind: 'distance-oneshot', targetOffsetY: 2300 });
    });

    it('targets the bottom for follow-bottom entries even when an anchor exists', () => {
        expect(resolveEntryRestoreTarget(buildParams({
            snapshot: {
                shouldFollowBottom: true,
                offsetY: 0,
                anchor: { itemId: 'msg:m-20', messageId: 'm-20', itemOffsetPx: 84 },
            },
            fillSettled: false,
        }))).toEqual({ kind: 'bottom' });
    });

    it('skips scrolling entirely when settled content fits the viewport', () => {
        const underFilled = { contentHeight: 500, layoutHeight: 800 };

        expect(resolveEntryRestoreTarget(buildParams({
            contentMeasured: underFilled,
            snapshot: {
                shouldFollowBottom: false,
                offsetY: 120,
                anchor: { itemId: 'msg:m-20', messageId: 'm-20', itemOffsetPx: 84 },
            },
        }))).toEqual({ kind: 'none', reason: 'content-fits-viewport' });

        expect(resolveEntryRestoreTarget(buildParams({
            contentMeasured: underFilled,
            snapshot: { shouldFollowBottom: true, offsetY: 0, anchor: null },
        }))).toEqual({ kind: 'none', reason: 'content-fits-viewport' });
    });

    it('keeps an anchored restore alive while an under-filled fill has not settled', () => {
        // An under-filled UNSETTLED list must not take the final
        // `content-fits-viewport` verdict, which would close the transaction and
        // permanently forfeit the restore. It stays a WAIT verdict, and the same
        // anchor resolves as soon as the fill produces a scrollable range.
        const underFilled = buildParams({
            contentMeasured: { contentHeight: 500, layoutHeight: 800 },
            fillSettled: false,
            snapshot: {
                shouldFollowBottom: false,
                offsetY: 120,
                anchor: { itemId: 'msg:m-20', messageId: 'm-20', itemOffsetPx: 84 },
            },
        });

        expect(resolveEntryRestoreTarget(underFilled)).toEqual({ kind: 'none', reason: 'content-unmeasured' });

        expect(resolveEntryRestoreTarget({
            ...underFilled,
            contentMeasured: { contentHeight: 4_000, layoutHeight: 800 },
        })).toEqual({ kind: 'anchor', index: 1, itemOffsetPx: 84 });
    });

    describe('anchor writes require a measured scrollable range', () => {
        const anchoredSnapshot = {
            shouldFollowBottom: false,
            offsetY: 600,
            anchor: { itemId: 'msg:m-20', messageId: 'm-20', itemOffsetPx: 84 },
        } as const;

        it('waits instead of issuing an anchor write into a list with no scrollable range', () => {
            // Native arms the entry with the content height ZEROED by construction,
            // so an anchor target resolved on the data fact alone becomes a
            // scrollToIndex into a list that can only land at offset 0 — and the
            // entry transaction counts that landing as its one authorized write.
            expect(resolveEntryRestoreTarget(buildParams({
                snapshot: anchoredSnapshot,
                contentMeasured: { contentHeight: 0, layoutHeight: 800 },
                fillSettled: false,
            }))).toEqual({ kind: 'none', reason: 'content-unmeasured' });

            // Measured, but the scrollable range is exactly zero.
            expect(resolveEntryRestoreTarget(buildParams({
                snapshot: anchoredSnapshot,
                contentMeasured: { contentHeight: 800, layoutHeight: 800 },
                fillSettled: false,
            }))).toEqual({ kind: 'none', reason: 'content-unmeasured' });

            // Under-filled while the fill has not settled.
            expect(resolveEntryRestoreTarget(buildParams({
                snapshot: anchoredSnapshot,
                contentMeasured: { contentHeight: 500, layoutHeight: 800 },
                fillSettled: false,
            }))).toEqual({ kind: 'none', reason: 'content-unmeasured' });

            // Content measured but the viewport is not laid out yet.
            expect(resolveEntryRestoreTarget(buildParams({
                snapshot: anchoredSnapshot,
                contentMeasured: { contentHeight: 4_000, layoutHeight: 0 },
                fillSettled: false,
            }))).toEqual({ kind: 'none', reason: 'content-unmeasured' });
        });

        it('waits for the same geometry before restoring through a nearest surviving anchor', () => {
            expect(resolveEntryRestoreTarget(buildParams({
                snapshot: {
                    shouldFollowBottom: false,
                    offsetY: 600,
                    anchor: { itemId: 'msg:m-25', messageId: 'm-25', itemOffsetPx: 48 },
                },
                contentMeasured: { contentHeight: 0, layoutHeight: 800 },
                fillSettled: false,
            }))).toEqual({ kind: 'none', reason: 'content-unmeasured' });
        });

        it('issues the anchor write on the first resolve that carries a real scrollable range', () => {
            // The wait verdict is a no-op at the owner, so the existing re-drive
            // (layout effect keyed on list content/layout height) re-resolves these
            // same params once geometry exists.
            const unmeasured = buildParams({
                snapshot: anchoredSnapshot,
                contentMeasured: { contentHeight: 0, layoutHeight: 800 },
                fillSettled: false,
            });
            expect(resolveEntryRestoreTarget(unmeasured)).toEqual({ kind: 'none', reason: 'content-unmeasured' });

            expect(resolveEntryRestoreTarget({
                ...unmeasured,
                contentMeasured: { contentHeight: 801, layoutHeight: 800 },
            })).toEqual({ kind: 'anchor', index: 1, itemOffsetPx: 84 });
        });

        it('gates on the measured range and not on fill settle', () => {
            // A real scrollable range restores immediately, mid-fill: waiting for
            // fillSettled would push the write past the first-paint cover deadline.
            expect(resolveEntryRestoreTarget(buildParams({
                snapshot: anchoredSnapshot,
                contentMeasured: { contentHeight: 4_000, layoutHeight: 800 },
                fillSettled: false,
            }))).toEqual({ kind: 'anchor', index: 1, itemOffsetPx: 84 });
        });
    });

    it('returns none for an empty transcript', () => {
        expect(resolveEntryRestoreTarget(buildParams({
            items: [],
        }))).toEqual({ kind: 'none', reason: 'empty-transcript' });

        expect(resolveEntryRestoreTarget(buildParams({
            items: [],
            snapshot: { shouldFollowBottom: true, offsetY: 0, anchor: null },
        }))).toEqual({ kind: 'none', reason: 'empty-transcript' });
    });

    it('does not match anchors against fork divider items', () => {
        const forkedItems: readonly TestItem[] = [
            { id: 'fork-divider:parent:child', kind: 'fork-divider' },
            ...loadedItems,
        ];

        expect(resolveEntryRestoreTarget(buildParams({
            items: forkedItems,
            snapshot: {
                shouldFollowBottom: false,
                offsetY: 600,
                anchor: { itemId: 'msg:m-20', messageId: 'm-20', itemOffsetPx: 84 },
            },
        }))).toEqual({ kind: 'anchor', index: 2, itemOffsetPx: 84 });

        expect(resolveEntryRestoreTarget(buildParams({
            items: forkedItems,
            snapshot: {
                shouldFollowBottom: false,
                offsetY: 600,
                anchor: { itemId: 'msg:m-25', messageId: 'm-25', itemOffsetPx: 48 },
            },
        }))).toEqual({ kind: 'anchor', index: 2, itemOffsetPx: 48 });
    });
});
