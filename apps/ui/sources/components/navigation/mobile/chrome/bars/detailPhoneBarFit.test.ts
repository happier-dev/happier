import { describe, expect, it } from 'vitest';

import { resolveDetailPhoneBarFit, resolveDetailPhonePlacement, type PhonePlacementItem } from './detailPhoneNavigationProjection';

const items = (count: number): PhonePlacementItem[] => Array.from({ length: count }, (_, index) => ({
    id: `tab-${index}`, navigation: { kind: 'page' as const },
}));

describe('phone detail bar fit', () => {
    it('counts the room the selected tab’s name takes when labels are off, so a bar that only fits as icons scrolls', () => {
        const placement = resolveDetailPhonePlacement(items(8), undefined, 'bottom');
        // Eight icons and More fit nine slots exactly.
        expect(resolveDetailPhoneBarFit(placement, 9).mode).toBe('fit');
        // The selected tab says its name (owner 11-06), which takes one more slot: the bar scrolls instead of clipping it.
        expect(resolveDetailPhoneBarFit(placement, 9, 'scroll', { selectedLabelSlots: 1 }).mode).toBe('scroll');
        expect(resolveDetailPhoneBarFit(placement, 10, 'scroll', { selectedLabelSlots: 1 }).mode).toBe('fit');
    });

    // Owner 11-10: More is never replaced. An item opened from More rides the bar just before More while it is open.
    it('puts the open item from More on the bar just before More, and keeps it listed behind More', () => {
        const placement = resolveDetailPhonePlacement(items(6), { orderedIds: [], placements: { 'tab-4': 'overflow', 'tab-5': 'hidden' } }, 'bottom');
        const resting = resolveDetailPhoneBarFit(placement, 9);
        expect(resting.shown.map(item => item.id)).toEqual(['tab-0', 'tab-1', 'tab-2', 'tab-3']);
        expect(resting.visitor).toBeNull();

        const visiting = resolveDetailPhoneBarFit(placement, 9, 'scroll', { activeId: 'tab-4' });
        expect(visiting.shown.map(item => item.id)).toEqual(['tab-0', 'tab-1', 'tab-2', 'tab-3', 'tab-4']);
        expect(visiting.visitor?.id).toBe('tab-4');
        expect(visiting.behindMore.map(item => item.id)).toEqual(['tab-4']);
        // A hidden item reached another way still shows where the person is.
        expect(resolveDetailPhoneBarFit(placement, 9, 'scroll', { activeId: 'tab-5' }).shown.at(-1)?.id).toBe('tab-5');
        // An item already on the bar is not repeated.
        expect(resolveDetailPhoneBarFit(placement, 9, 'scroll', { activeId: 'tab-1' }).visitor).toBeNull();
    });

    it('keeps an open page off the bottom bar when pages sit at the top, where only companions ride it', () => {
        const mixed: PhonePlacementItem[] = [
            { id: 'chat', navigation: { kind: 'page' } }, { id: 'files', navigation: { kind: 'page' } },
            { id: 'notes', navigation: { kind: 'page' } }, { id: 'tools', navigation: { kind: 'companion' } },
        ];
        const placement = resolveDetailPhonePlacement(mixed, { orderedIds: [], placements: { notes: 'overflow', tools: 'overflow' } }, 'top');
        expect(resolveDetailPhoneBarFit(placement, 9, 'scroll', { activeId: 'notes' }).visitor).toBeNull();
        expect(resolveDetailPhoneBarFit(placement, 9, 'scroll', { activeId: 'tools' }).visitor?.id).toBe('tools');
    });

    it('makes room for the visitor in a bar that holds its excess in More', () => {
        const placement = resolveDetailPhonePlacement(items(6), { orderedIds: [], placements: { 'tab-5': 'overflow' } }, 'bottom');
        // Five pinned tabs and More fill six slots exactly.
        expect(resolveDetailPhoneBarFit(placement, 6, 'more').mode).toBe('fit');
        const visiting = resolveDetailPhoneBarFit(placement, 6, 'more', { activeId: 'tab-5' });
        expect(visiting.shown.map(item => item.id)).toEqual(['tab-0', 'tab-1', 'tab-2', 'tab-3', 'tab-5']);
        expect(visiting.held.map(item => item.id)).toEqual(['tab-4']);
        // A pinned tab held in More is the visitor while it is open.
        expect(resolveDetailPhoneBarFit(placement, 5, 'more').held.map(item => item.id)).toEqual(['tab-4']);
        const held = resolveDetailPhoneBarFit(placement, 5, 'more', { activeId: 'tab-4' });
        expect(held.shown.map(item => item.id)).toEqual(['tab-0', 'tab-1', 'tab-2', 'tab-4']);
        expect(held.held.map(item => item.id)).toEqual(['tab-3', 'tab-4']);
    });
});
