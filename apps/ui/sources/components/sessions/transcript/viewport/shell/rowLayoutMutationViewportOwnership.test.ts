import { describe, expect, it } from 'vitest';

import { resolveRowLayoutMutationViewportOwnershipAction } from './rowLayoutMutationViewportOwnership';

describe('resolveRowLayoutMutationViewportOwnershipAction', () => {
    // Live native S-C continuation (2026-07-11): the tool ROW inline expand/collapse
    // (ToolTimelineRow -> TranscriptCollapsible) commits a giant in-viewport height change
    // WITHOUT passing the group-toggle choke point, so no visible-anchor hold was armed and
    // the expansion parked the viewport hours away (offset 5559 -> 2590, firstVisibleItemId
    // changed, zero writer events). Every expand/collapse row mutation must arm the ONE keyed hold.
    it('arms the renderer hold for expand and collapse mutations', () => {
        expect(resolveRowLayoutMutationViewportOwnershipAction({
            reason: 'expand',
        })).toBe('arm-visible-anchor-hold');
        expect(resolveRowLayoutMutationViewportOwnershipAction({
            reason: 'collapse',
        })).toBe('arm-visible-anchor-hold');
    });

    it('arms the renderer hold for bounded async content replacement or growth', () => {
        expect(resolveRowLayoutMutationViewportOwnershipAction({
            reason: 'content-change',
        })).toBe('arm-visible-anchor-hold');
    });

    it('never arms for non-toggle signature changes', () => {
        expect(resolveRowLayoutMutationViewportOwnershipAction({
            reason: 'signature-change',
        })).toBe('none');
    });
});
