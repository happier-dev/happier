import { describe, expect, it } from 'vitest';

import { resolveTranscriptViewportAnchorIndex } from '@/components/sessions/transcript/viewport/entryRestore/transcriptViewportAnchorResolution';
import type { EntryRestoreTransactionTarget } from './entryRestoreTransaction';
import {
    resolveEntryRestoreTarget,
    type EntryRestoreAnchorSnapshot,
    type EntryRestoreSliceCapability,
    type EntryRestoreTarget,
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

    it('still resolves anchors while an under-filled fill has not settled', () => {
        expect(resolveEntryRestoreTarget(buildParams({
            contentMeasured: { contentHeight: 500, layoutHeight: 800 },
            fillSettled: false,
            snapshot: {
                shouldFollowBottom: false,
                offsetY: 120,
                anchor: { itemId: 'msg:m-20', messageId: 'm-20', itemOffsetPx: 84 },
            },
        }))).toEqual({ kind: 'anchor', index: 1, itemOffsetPx: 84 });
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

    describe('slice outcome (N2b, write-free anchored entry)', () => {
        const sliceCapability: EntryRestoreSliceCapability = { hostCanBuildAnchorWindow: true };
        const anchoredSnapshot = {
            shouldFollowBottom: false,
            offsetY: 600,
            anchor: { itemId: 'msg:m-3', messageId: 'm-3', itemOffsetPx: 12 },
        } as const;

        function buildSliceParams(
            overrides: Partial<ResolveEntryRestoreTargetParams<TestItem>> = {},
        ): ResolveEntryRestoreTargetParams<TestItem> & Readonly<{ slice: EntryRestoreSliceCapability }> {
            return { ...buildParams(overrides), slice: sliceCapability };
        }

        it('returns slice for an anchored entry when the host can build the anchor window', () => {
            expect(resolveEntryRestoreTarget(buildSliceParams({
                snapshot: anchoredSnapshot,
                anchorSeqResolver: (anchor) => (anchor.messageId ? anchorSeqByMessageId[anchor.messageId] ?? null : null),
            }))).toEqual({
                kind: 'slice',
                anchorMessageId: 'm-3',
                anchorSeq: 3,
                anchorItemOffsetPx: 12,
            });
        });

        it('wins over wait and final none verdicts: the slice decides what to fill', () => {
            // Empty/unmeasured/unsettled states are legitimate at the
            // initial-window decision point — slice precedes the fill barrier.
            const sliceTarget = {
                kind: 'slice',
                anchorMessageId: 'm-3',
                anchorSeq: null,
                anchorItemOffsetPx: 12,
            };

            expect(resolveEntryRestoreTarget(buildSliceParams({
                snapshot: anchoredSnapshot,
                items: [],
            }))).toEqual(sliceTarget);

            expect(resolveEntryRestoreTarget(buildSliceParams({
                snapshot: anchoredSnapshot,
                contentMeasured: { contentHeight: 0, layoutHeight: 0 },
                fillSettled: false,
            }))).toEqual(sliceTarget);

            expect(resolveEntryRestoreTarget(buildSliceParams({
                snapshot: anchoredSnapshot,
                contentMeasured: { contentHeight: 500, layoutHeight: 800 },
            }))).toEqual(sliceTarget);
        });

        it('prefers the seq stamped on the hydrated anchor over the seq resolver', () => {
            expect(resolveEntryRestoreTarget(buildSliceParams({
                snapshot: {
                    ...anchoredSnapshot,
                    anchor: { ...anchoredSnapshot.anchor, seq: 99 },
                },
                anchorSeqResolver: () => 3,
            }))).toEqual({
                kind: 'slice',
                anchorMessageId: 'm-3',
                anchorSeq: 99,
                anchorItemOffsetPx: 12,
            });
        });

        it('keeps follow-bottom entries on their write-free bottom path', () => {
            expect(resolveEntryRestoreTarget(buildSliceParams({
                snapshot: { shouldFollowBottom: true, offsetY: 0, anchor: { ...anchoredSnapshot.anchor } },
            }))).toEqual({ kind: 'bottom' });
        });

        it('does not restore identity-less anchors as if they were durable anchor restores', () => {
            expect(resolveEntryRestoreTarget(buildSliceParams({
                snapshot: {
                    shouldFollowBottom: false,
                    offsetY: 600,
                    anchor: { itemId: 'divider:1', messageId: null, itemOffsetPx: 0 },
                },
            }))).toEqual({ kind: 'none', reason: 'missing-durable-anchor' });
        });

        it('never returns slice to hosts that did not opt in (type- and value-level)', () => {
            // Without the capability the same params resolve through the
            // existing pipeline; the return type has no 'slice' member.
            const resolved: EntryRestoreTarget = resolveEntryRestoreTarget(buildParams({
                snapshot: anchoredSnapshot,
                canMaterializeOlder: true,
            }));
            expect(resolved).toEqual({ kind: 'anchor', index: 0, itemOffsetPx: 12 });
        });

        it('keeps slice out of the writable entry-transaction target space (type-level)', () => {
            const sliceOutcome = resolveEntryRestoreTarget(buildSliceParams({
                snapshot: anchoredSnapshot,
            }));
            expect(sliceOutcome.kind).toBe('slice');
            if (sliceOutcome.kind !== 'slice') return;
            // @ts-expect-error a slice outcome is a data-layer act, never a writable transaction target
            const target: EntryRestoreTransactionTarget = sliceOutcome;
            expect(target.kind).toBe('slice');
        });
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
